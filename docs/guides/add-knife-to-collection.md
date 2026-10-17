# Add Knife to collection

BladeVault can fill a record for you instead of typing a dozen specifications yourself: paste a product URL, review what came back, save. Every screenshot below is from a real import — a Vosteed CheesePirates (A2932) from `vosteed.com`.

## 1. Click **Add knife**

Click **Add knife** at the top of the sidebar:

![The Add knife button at the top of the sidebar](../images/add-knife-button.png)

The form opens on the **Scrape URL** tab. The other tab, **Manual**, is for entering a knife
yourself: [Add knife in manual mode](add-knife-in-manual-mode.md).

![The Add knife form, open on the Scrape URL tab](../images/add-knife-form.png)

## 2. Paste the product URL and click **Scrape**

Put the retailer's product page into **Product URL** and click **Scrape** (pressing Enter works too). BladeVault opens the page in a real browser, takes the title, brand, images and specifications, and downloads the product photos into your vault.

![The form after pasting a product URL, with Scrape and Batch scrape on the right](../images/add-knife-url.png)

## 3. Check what the import filled in

![Imported values from a Vosteed product page, with the scraped page preview beside the form](../images/add-knife-imported.png)

The form comes back filled: brand/maker, model name, model number, price, dimensions (overall, blade, thickness, weight), construction (blade material, style, coating, handle material, locking mechanism, hardness), and the description. Where a page gives two different values for one field — this one lists two handle lengths for its variants — the import leaves the field empty and says why, so nothing is guessed in. Every field stays editable, and **Scraped page preview** shows the source page next to the form so a value can be checked against the page it came from.

## 4. Choose the images to keep

![Imported product images, all selected, with the cover marked](../images/add-knife-images.png)

Product images are downloaded into the vault with the record, so they travel with your data and are included in ZIP backups and [cloud backups](../reference/cloud-backup.md). Deselect the ones you do not want, set a **cover**, reorder or remove them — or add your own photos and image URLs.

## 5. Save knife to collection

At the bottom right of the form, click **Save Item**:

![The Save Item button at the bottom right of the form](../images/add-knife-save-bar.png)

![The bottom of the form after the import, with the Cancel and Save Item action bar](../images/add-knife-save.png)

**Save Item** writes the record and takes you to the collection.

## 6. See the saved knife

![The saved knife: imported specifications, images, and the source link](../images/add-knife-saved.png)

The knife opens with everything the import wrote — specifications, gallery, source link, notes — and all of it stays editable afterwards.

![The imported knife as a card in the collection](../images/add-knife-collection.png)

In the collection it appears as a card, ready for the next one.

## Add several links at once

**Batch scrape** takes a pasted list of product URLs and adds them one after another — sequentially, not in parallel, so a retailer never sees a burst of requests from you. Products you already saved from the same source URL are skipped. Full walkthrough: [Add several knives at once](add-several-knives.md).

## Add a knife manually

The **Manual** tab gives you every field to fill in yourself, which is the right path for a knife with no product page — a gift, a custom build, an older piece with no online listing. Along with the built-in specifications you can store pricing, provenance, notes, links, and local photos. Full walkthrough: [Add knife in manual mode](add-knife-in-manual-mode.md).

## When a retailer blocks the import

Some sites block automated access. BladeVault clears recognizable newsletter and cookie overlays before capturing the page; for anything left over, use **Hide popups** in the preview to drop the remaining dialogs, or **Restore original** to return to the imported preview. Neither touches your form edits.

For popups that need a real click, or a retailer's verification step, choose **Interact with page** beside the URL. Close the popup in the browser window, then click **Continue** and the import refreshes into the same form — manually edited fields and image selections are kept. That browser window opens on the computer running BladeVault; a browser running inside a remote container is not streamed to your screen.

## Capture the source page

BladeVault can also save a permanent full-page screenshot of the page a record came from — the knife imported above has one. See [Capture source pages](capture-sources.md).

## Requirements

- **From source:** install Chromium (`npx playwright install chromium`) so URL import and capture can run.
- **Docker, desktop, Kubernetes:** the shipped image and desktop build already include the browser runtime.

## Next

- [Update a saved knife](update-a-saved-knife.md) — correct and extend what an import wrote.
- [Organize your collection](collection.md) — custom fields, cards, and Smart Collections.
- [Capture source pages](capture-sources.md) — keep the page you imported from.
