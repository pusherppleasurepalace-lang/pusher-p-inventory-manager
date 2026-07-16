"use strict";
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";
const tokenCache = { value: null, expiresAt: 0 };
const taxonomyCategoryCache = new Map();
const BACKEND_BUILD = "1.0.9";

app.disable("x-powered-by");
app.use(helmet({crossOriginResourcePolicy:{policy:"cross-origin"}}));
app.use(cors({
  origin(origin, cb) {
    if (!origin || origin.startsWith("chrome-extension://")) return cb(null, true);
    cb(new Error("Origin not allowed"));
  },
  methods:["GET","POST","OPTIONS"],
  allowedHeaders:["Content-Type","X-Importer-Key"]
}));
app.use(express.json({limit:"2mb"}));

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function normalizeShop(value) {
  return String(value||"").trim().replace(/^https?:\/\//i,"").replace(/\/.*$/,"").toLowerCase();
}
function safeEqual(a,b) {
  const x=Buffer.from(String(a||"")), y=Buffer.from(String(b||""));
  return x.length===y.length && crypto.timingSafeEqual(x,y);
}
function verifyKey(req,res,next) {
  try {
    if (!safeEqual(req.get("X-Importer-Key"), requiredEnv("IMPORTER_API_KEY"))) {
      return res.status(401).json({ok:false,error:"Unauthorized importer request."});
    }
    next();
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
}
async function getAccessToken() {
  const now=Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt-60000) return tokenCache.value;
  const shop=normalizeShop(requiredEnv("SHOPIFY_STORE"));
  const body=new URLSearchParams({
    grant_type:"client_credentials",
    client_id:requiredEnv("SHOPIFY_CLIENT_ID"),
    client_secret:requiredEnv("SHOPIFY_CLIENT_SECRET")
  });
  const r=await fetch(`https://${shop}/admin/oauth/access_token`,{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},
    body
  });
  const data=await r.json().catch(()=>({}));
  if (!r.ok || !data.access_token) {
    throw new Error(`Shopify token request failed (${r.status}): ${data.error_description||data.error||JSON.stringify(data)}`);
  }
  tokenCache.value=data.access_token;
  tokenCache.expiresAt=now+Number(data.expires_in||86399)*1000;
  return tokenCache.value;
}
async function gql(query,variables={}) {
  const shop=normalizeShop(requiredEnv("SHOPIFY_STORE"));
  const token=await getAccessToken();
  const r=await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`,{
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json","X-Shopify-Access-Token":token},
    body:JSON.stringify({query,variables})
  });
  const payload=await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`Shopify HTTP error (${r.status}): ${JSON.stringify(payload)}`);
  if (payload.errors?.length) throw new Error(`Shopify GraphQL error: ${JSON.stringify(payload.errors)}`);
  return payload.data;
}
function cleanText(v,max=5000){return String(v??"").trim().slice(0,max);}
function normalizeProduct(input){
  const p={
    title:cleanText(input.title,255),
    sku:cleanText(input.sku,255),
    descriptionHtml:cleanText(input.description_html,100000),
    vendor:cleanText(input.vendor||"Pusher P",255),
    productType:cleanText(input.category||"Jewelry",255),
    price:Number(input.price),
    quantity:Math.max(0,Math.trunc(Number(input.quantity)||0)),
    bin:cleanText(input.bin,255),
    images:[...new Set((Array.isArray(input.images)?input.images:[]).map(String).filter(x=>/^https:\/\//i.test(x)))].slice(0,10)
  };
  if(!p.title) throw new Error("Product title is required.");
  if(!p.sku) throw new Error("Product SKU is required.");
  if(!Number.isFinite(p.price)||p.price<0) throw new Error("A valid product price is required.");
  return p;
}
async function findVariantBySku(sku){
  const query=`query($q:String!){productVariants(first:1,query:$q){nodes{id sku product{id title handle} inventoryItem{id tracked}}}}`;
  const escaped=sku.replaceAll("\\","\\\\").replaceAll('"','\\"');
  const d=await gql(query,{q:`sku:"${escaped}"`});
  return d.productVariants.nodes[0]||null;
}
async function getLocation(){
  const d=await gql(`query{locations(first:25,query:"active:true"){nodes{id name isActive fulfillsOnlineOrders}}}`);
  const list=d.locations.nodes||[];
  if(!list.length) throw new Error("No active Shopify inventory location was found.");
  return list.find(x=>x.fulfillsOnlineOrders)||list.find(x=>x.isActive)||list[0];
}
function metafields(p){
  return p.bin?[{namespace:"custom",key:"bin_location",type:"single_line_text_field",value:p.bin}]:[];
}
function media(p){
  return p.images.map((url,i)=>({originalSource:url,mediaContentType:"IMAGE",alt:`${p.title}${i?` image ${i+1}`:""}`}));
}
function normalizedJewelryType(value){
  const text=String(value||"").trim().toLowerCase();
  if(/earring|hoop|stud|clip-on/.test(text)) return "Earrings";
  if(/necklace|pendant|choker/.test(text)) return "Necklaces";
  if(/bracelet|bangle|cuff/.test(text)) return "Bracelets";
  if(/anklet/.test(text)) return "Anklets";
  if(/ring/.test(text)) return "Rings";
  if(/brooch|pin/.test(text)) return "Brooches & Lapel Pins";
  if(/jewelry|jewellery/.test(text)) return "Jewelry";
  return "Jewelry";
}
async function resolveTaxonomyCategory(productType){
  const wanted=normalizedJewelryType(productType);
  if(taxonomyCategoryCache.has(wanted)) return taxonomyCategoryCache.get(wanted);

  const query=`query($search:String!){
    taxonomy{
      categories(first:50,search:$search){
        nodes{id name fullName isArchived isLeaf}
      }
    }
  }`;

  async function search(term){
    const d=await gql(query,{search:term});
    return (d.taxonomy?.categories?.nodes||[]).filter(x=>x?.id&&!x.isArchived);
  }

  let nodes=await search(wanted);
  if(!nodes.length&&wanted!=="Jewelry") nodes=await search("Jewelry");

  const jewelryNodes=nodes.filter(x=>/apparel\s*&\s*accessories.*jewelry/i.test(x.fullName||""));
  const pool=jewelryNodes.length?jewelryNodes:nodes;
  const wantedLower=wanted.toLowerCase();

  let match=pool.find(x=>String(x.name||"").toLowerCase()===wantedLower);
  if(!match) match=pool.find(x=>String(x.fullName||"").toLowerCase().endsWith(`> ${wantedLower}`));
  if(!match&&wanted==="Jewelry") match=pool.find(x=>String(x.name||"").toLowerCase()==="jewelry");
  if(!match) match=pool.find(x=>x.isLeaf);
  if(!match) match=pool[0]||null;

  const result=match?{id:match.id,name:match.name,fullName:match.fullName}:null;
  taxonomyCategoryCache.set(wanted,result);
  return result;
}
async function createProduct(p){
  const taxonomyCategory=await resolveTaxonomyCategory(p.productType);
  const mutation=`mutation($product:ProductCreateInput!,$media:[CreateMediaInput!]){
    productCreate(product:$product,media:$media){
      product{id title handle variants(first:1){nodes{id inventoryItem{id tracked}}}}
      userErrors{field message}
    }
  }`;
  const d=await gql(mutation,{product:{
    title:p.title,descriptionHtml:p.descriptionHtml,vendor:p.vendor,
    productType:p.productType,status:"ACTIVE",metafields:metafields(p),
    ...(taxonomyCategory?.id?{category:taxonomyCategory.id}:{})
  },media:media(p)});
  const r=d.productCreate;
  if(r.userErrors?.length) throw new Error(`Product creation failed: ${JSON.stringify(r.userErrors)}`);
  const v=r.product?.variants?.nodes?.[0];
  if(!r.product?.id||!v?.id||!v?.inventoryItem?.id) throw new Error("Shopify did not return the default variant.");
  return {productId:r.product.id,title:r.product.title,handle:r.product.handle,variantId:v.id,inventoryItemId:v.inventoryItem.id};
}
async function updateVariant(productId,variantId,p){
  const mutation=`mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){
    productVariantsBulkUpdate(productId:$productId,variants:$variants){
      productVariants{id inventoryItem{id}}
      userErrors{field message}
    }
  }`;
  const d=await gql(mutation,{productId,variants:[{
    id:variantId,price:p.price.toFixed(2),inventoryItem:{sku:p.sku,tracked:true}
  }]});
  const r=d.productVariantsBulkUpdate;
  if(r.userErrors?.length) throw new Error(`Variant update failed: ${JSON.stringify(r.userErrors)}`);
  return r.productVariants?.[0]?.inventoryItem?.id;
}
async function updateExisting(existing,p){
  const taxonomyCategory=await resolveTaxonomyCategory(p.productType);
  // Update product fields without re-adding media. This prevents duplicate images
  // when the same SKU is retried after a later inventory step fails.
  const mutation=`mutation($product:ProductUpdateInput!){
    productUpdate(product:$product){
      product{id title handle}
      userErrors{field message}
    }
  }`;
  const d=await gql(mutation,{product:{
    id:existing.product.id,title:p.title,descriptionHtml:p.descriptionHtml,vendor:p.vendor,
    productType:p.productType,status:"ACTIVE",metafields:metafields(p),
    ...(taxonomyCategory?.id?{category:taxonomyCategory.id}:{})
  }});
  const r=d.productUpdate;
  if(r.userErrors?.length) throw new Error(`Product update failed: ${JSON.stringify(r.userErrors)}`);
  await updateVariant(existing.product.id,existing.id,p);
  return {productId:existing.product.id,title:r.product.title,handle:r.product.handle,variantId:existing.id,inventoryItemId:existing.inventoryItem.id};
}
async function ensureTracked(inventoryItemId,sku){
  const mutation=`mutation($id:ID!,$input:InventoryItemInput!){
    inventoryItemUpdate(id:$id,input:$input){inventoryItem{id sku tracked} userErrors{field message}}
  }`;
  const d=await gql(mutation,{id:inventoryItemId,input:{sku,tracked:true}});
  if(d.inventoryItemUpdate.userErrors?.length) throw new Error(`Inventory item update failed: ${JSON.stringify(d.inventoryItemUpdate.userErrors)}`);
}
async function activateInventory(inventoryItemId,locationId){
  const mutation=`mutation($inventoryItemId:ID!,$locationId:ID!,$idempotencyKey:String!){
    inventoryActivate(inventoryItemId:$inventoryItemId,locationId:$locationId) @idempotent(key:$idempotencyKey){
      inventoryLevel{id} userErrors{field message}
    }
  }`;
  const d=await gql(mutation,{
    inventoryItemId,
    locationId,
    idempotencyKey:crypto.randomUUID()
  });
  const errors=d.inventoryActivate.userErrors||[];
  if(errors.length&&!errors.every(e=>/already active|already stocked|already connected/i.test(e.message||""))){
    throw new Error(`Inventory activation failed: ${JSON.stringify(errors)}`);
  }
}
async function getAllPublications(){
  const d=await gql(`query{publications(first:100){nodes{id name catalog{title}}}}`);
  return (d.publications?.nodes||[]).filter(x=>x?.id);
}
async function publishToAllChannels(productId){
  let publications;
  try{
    publications=await getAllPublications();
  }catch(e){
    const message=String(e?.message||e);
    if(/access scope|read_publications|write_publications|forbidden|unauthorized/i.test(message)){
      return {publishedCount:0,totalCount:0,warning:"Shopify app permission required: add read_publications and write_publications, reinstall/update the app, then redeploy."};
    }
    throw e;
  }
  if(!publications.length){
    return {publishedCount:0,totalCount:0,warning:"Shopify returned no sales-channel publications available to this app."};
  }
  const mutation=`mutation($id:ID!,$input:[PublicationInput!]!){
    publishablePublish(id:$id,input:$input){
      userErrors{field message}
    }
  }`;
  const input=publications.map(x=>({publicationId:x.id}));
  try{
    const d=await gql(mutation,{id:productId,input});
    const userErrors=d.publishablePublish?.userErrors||[];
    const meaningful=userErrors.filter(e=>!/already published/i.test(e.message||""));
    const names=publications.map(x=>x.name||x.catalog?.title).filter(Boolean);
    if(meaningful.length){
      return {publishedCount:Math.max(0,publications.length-meaningful.length),totalCount:publications.length,channels:names,warning:meaningful.map(e=>e.message).join(" | ")};
    }
    return {publishedCount:publications.length,totalCount:publications.length,channels:names,warning:""};
  }catch(e){
    const message=String(e?.message||e);
    if(/access scope|write_publications|forbidden|unauthorized/i.test(message)){
      return {publishedCount:0,totalCount:publications.length,channels:publications.map(x=>x.name||x.catalog?.title).filter(Boolean),warning:"Shopify app permission required: add write_publications and reinstall/update the app."};
    }
    throw e;
  }
}
async function setInventory(inventoryItemId,locationId,quantity){
  const mutation=`mutation($input:InventorySetQuantitiesInput!,$idempotencyKey:String!){
    inventorySetQuantities(input:$input) @idempotent(key:$idempotencyKey){
      inventoryAdjustmentGroup{createdAt reason changes{name delta}}
      userErrors{field message}
    }
  }`;
  const d=await gql(mutation,{
    idempotencyKey:crypto.randomUUID(),
    input:{
      name:"available",
      reason:"correction",
      referenceDocumentUri:`gid://pusher-p-inventory/import/${Date.now()}-${crypto.randomUUID()}`,
      quantities:[{inventoryItemId,locationId,quantity,changeFromQuantity:null}]
    }
  });
  if(d.inventorySetQuantities.userErrors?.length) throw new Error(`Inventory update failed: ${JSON.stringify(d.inventorySetQuantities.userErrors)}`);
}

app.get("/",(req,res)=>res.send(`<!doctype html><html><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#080808;color:white;font-family:Arial"><main style="text-align:center;border-top:4px solid #d00000;padding:40px;background:#121212;border-radius:14px"><h1>Pusher P Inventory Manager</h1><p style="color:#d6b56c">Powered by Intention</p><div style="color:#9cffb8">Backend is online ✓</div></main></body></html>`));
app.get("/health",(req,res)=>{
  try{res.json({ok:true,shop:normalizeShop(requiredEnv("SHOPIFY_STORE")),apiVersion:API_VERSION,build:BACKEND_BUILD,time:new Date().toISOString()});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.get("/shopify-check",verifyKey,async(req,res)=>{
  try{const d=await gql(`query{shop{id name myshopifyDomain}}`);res.json({ok:true,shop:d.shop});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});
app.post("/api/products/import",verifyKey,async(req,res)=>{
  try{
    const p=normalizeProduct(req.body||{});
    const existing=await findVariantBySku(p.sku);
    const location=await getLocation();
    let result,action;
    if(existing){result=await updateExisting(existing,p);action="updated";}
    else{
      result=await createProduct(p);
      result.inventoryItemId=(await updateVariant(result.productId,result.variantId,p))||result.inventoryItemId;
      action="created";
    }
    await ensureTracked(result.inventoryItemId,p.sku);
    await activateInventory(result.inventoryItemId,location.id);
    await setInventory(result.inventoryItemId,location.id,p.quantity);
    const publishing=await publishToAllChannels(result.productId);
    const taxonomyCategory=await resolveTaxonomyCategory(p.productType);
    const shop=normalizeShop(requiredEnv("SHOPIFY_STORE"));
    const numericId=String(result.productId).split("/").pop();
    res.json({ok:true,build:BACKEND_BUILD,action,sku:p.sku,quantity:p.quantity,location:location.name,
      product:{id:result.productId,title:result.title,handle:result.handle,adminUrl:`https://${shop}/admin/products/${numericId}`},
      publishing,
      category:taxonomyCategory||null,
      note:publishing.warning||`Product is active, categorized as ${taxonomyCategory?.name||p.productType}, and published to ${publishing.publishedCount} of ${publishing.totalCount} available channels.`
    });
  }catch(e){console.error(e);res.status(500).json({ok:false,error:e.message});}
});
app.use((e,req,res,next)=>res.status(500).json({ok:false,error:e.message||"Unexpected server error."}));
app.listen(PORT,"0.0.0.0",()=>console.log(`Pusher P backend listening on ${PORT}`));
