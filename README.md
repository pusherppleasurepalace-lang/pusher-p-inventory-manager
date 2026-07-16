# Pusher P Inventory Manager Backend

Secure Shopify backend for the Pusher P Inventory Manager Chrome extension.

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
- Adds up to 10 images.
- Sets title, description, vendor, type, price, SKU, inventory, and bin location.
