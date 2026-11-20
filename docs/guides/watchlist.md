# Keep a watchlist of knives you want

The **Watchlist** keeps knives you want but don't own yet, each with an optional target price. Price Drops checks their stores on the same schedule as your collection, and the **Inbox** tells you when a price reaches your target or a wanted knife is back in stock. When you buy one, move it into your collection with its price history.

The watchlist needs the BladeVault server, like the rest of Price Drops: it works in the desktop app, Docker, Helm, and a source checkout, but not in the static web app.

## Add a wanted knife

1. Open **Price Drops** and select **Watchlist**.
2. Select **Add wanted knife**.
3. Paste the store's product page into **Product URL** and select **Read page**. BladeVault reads the name, brand, photo, and current price with the same importer as **Add knife**. If the page can't be read, type the name yourself.
4. Optionally enter a **Target price** and its currency (for example `120` and `USD`). The current price is suggested as a starting point.
5. Select **Add to watchlist**.

The product link becomes the knife's first store source and is checked at that store's next free slot. Add more stores under **Stores and monitoring** in the knife's panel; a wanted knife can have up to 10, like any knife.

## Read the watchlist

Each row shows:

| Column         | What it means                                                                              |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Best price** | The lowest in-stock price among its stores, in the target's currency when a target is set. |
| **Target**     | Your target price.                                                                         |
| **Gap**        | How far the best price is above the target, or **At target** when it is at or below it.    |
| **Stock**      | **In stock** when any store has it, **Out of stock** when every checked store is sold out. |
| **Checked**    | When a store was last read.                                                                |

Select a row to see its price history chart, stores, and latest changes, and to change the target. **Check now** on a store takes a reading right away.

## Get notified

Wanted knives use the regular **Inbox** price notifications, plus two of their own:

- **Reached your target price** arrives when a store's trusted reading is in stock, in the target's currency, and at or below your target. It stays open while the price stays there, and closes on its own when the price rises above the target or the store sells out, so the next time the price reaches it you are told again. A new or changed target is compared with the latest reading right away.
- **Back in stock** always notifies for a wanted knife, even when **Back in stock** is turned off in **Settings → Price monitoring**. Price drops and increases follow your usual notification settings. With a target set, only drops to the target notify, as **Reached your target price**. Muting the knife or a store in its alert rules also silences target alerts.

Select **Market** on a wanted knife's notification to open it on the watchlist.

## Buy it

When you buy a wanted knife, select **I bought it** in its panel, optionally enter what you paid (for example `129.00 USD`), and select **Move to collection**. The knife joins your collection with its photos, details, stores, and full price history. What you paid becomes its stored purchase price, so Price Drops keeps monitoring it in Auto mode and compares later prices with it. Open target notifications are closed.

**Remove** deletes a wanted knife together with its price history.

## What wanted knives don't affect

Wanted knives are stored in your vault but stay out of everything that describes your collection: the collection list and its counts, filters, search, Insights, Studio, activity history, comparisons, the Price Drops collection overview, and MCP collection searches and statistics. MCP `get_knife` still returns a wanted knife by id, marked `wanted: true`.

Backups and restores include the watchlist, since wanted knives live in the same vault database.

## Related

- [Watch market prices with Price Drops](price-drops.md) — schedules, stores, notifications, and AI assistance.
- [Back up and restore your vault](back-up-and-restore-your-vault.md) — what a backup includes.
