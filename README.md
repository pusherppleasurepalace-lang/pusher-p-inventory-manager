# Pusher P Inventory Manager Backend v1.0.6

Secure Shopify backend for the Pusher P Inventory Manager Chrome extension.

## Required Shopify app scopes

The app must have these Admin API scopes:

- `read_products`
- `write_products`
- `read_inventory`
- `write_inventory`
- `read_locations`
- `read_publications`
- `write_publications`

After adding publication scopes in the Shopify app configuration, release/update the app version so newly issued client-credentials tokens include them.

## Never upload secrets to GitHub

Enter these only in Render under **Environment**:

- `SHOPIFY_STORE`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `IMPORTER_API_KEY`

## Render settings

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`

## What it does

- Creates a product if the SKU is new.
- Updates the existing product if the SKU already exists.
- Adds up to 10 images on new products.
- Sets title, description, vendor, type, price, SKU, inventory, and bin location.
- Publishes the product to every publication/channel available to the app.
