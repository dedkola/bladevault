# Watch market prices with Price Drops

Price Drops checks the stores that sell the knives in your collection and records every price and stock change. Open **Price Drops** in the main navigation to see what changed, open a knife's **Market** tab for its price history, and find new drops and restocks in the **Inbox** under **Prices**.

Price monitoring needs the BladeVault server: it works in the desktop app, Docker, Helm, and a source checkout, but not in the static web app.

## Which knives are monitored

Every knife starts in **Auto** mode. In Auto, a knife is monitored when it has a stored purchase price above 0 and a product link (**Source URL**). Its product link becomes its first store source automatically.

| Mode               | What it does                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| **Auto**           | Monitors the knife when a purchase price is stored. Sold knives are skipped unless you change that. |
| **Always monitor** | Monitors the knife even without a stored price, and even when it is marked as sold.                 |
| **Never monitor**  | Leaves the knife out of scheduled checks. **Check now** still takes a single reading.               |

Change the mode for one knife in edit mode:

1. Open the knife and select **Edit**.
2. Scroll to **Price monitoring**. It explains whether the knife is monitored and why.
3. Choose **Auto**, **Always monitor**, or **Never monitor**.

## Add more stores for a knife

A knife can have up to 10 store sources from any store, including Amazon. Each source keeps its own history and status.

1. Open the knife and select **Edit**.
2. In **Price monitoring**, enter a product page in **Add store URL** and select **Add**.
3. Use **Pause** or **Resume** to stop or restart checks for one source, and **Remove** to stop monitoring it.

A removed source keeps its recorded history, which still appears in charts as a removed source. Changing the knife's **Source URL** moves its automatic source to the new link.

Each source also offers **How to load this page**. **Auto (learned per store)** is the right choice for almost every store; **Always browser** and **Always plain HTTP** are for stores where the automatic choice keeps failing.

## Read the Price Drops page

The page starts with counts of monitored knives, recent price drops and increases, sources that are out of stock, and the last successful check. Below them, switch between:

- **Recent changes** — every price and stock change, newest first.
- **Price drops** and **Increases** — price changes in the last 30 days.
- **Out of stock** — sources that currently show the knife as unavailable.
- **Recently monitored** — the latest checks, including failures and blocked stores.

Select a knife to see its best current price, price chart, and sources in the side panel. **Check all now** queues every monitored source; **Check now** on a source or knife checks just that one.

## Check one knife's market

Open a knife and select the **Market** tab. It shows:

- **Best price now** across its sources, next to **You paid** when a purchase price is stored.
- A price chart for 7 days up to all history, with each store as its own line and out-of-stock periods marked.
- **Sources** with each store's status: **Checked**, **Price unavailable**, **Out of stock**, **Failed**, **Blocked**, or **Not checked yet**.
- **Latest changes** for the knife.

Market prices are information only. They never change the purchase price stored in the knife's specifications.

## Get notified in the Inbox

New changes appear in the **Inbox** under **Prices** and in the header bell. Each notification shows the knife, the store, the old and new price, and the change in money and percent. Use **Market** to open the knife's Market tab, **Store page** to open the product page, **Mark read**, or **Dismiss**.

- One store keeps one notification per kind. A further drop at the same store updates that notification and marks it unread again instead of adding another.
- A change the other way closes the notification on its own: a price increase closes an open drop, and a restock closes an open out-of-stock notice.
- Dismissed and closed notifications stay under **Done** for 90 days.

Choose which changes notify you in **Settings → Price monitoring → Notifications**:

| Setting             | Default |
| ------------------- | ------- |
| **Price drops**     | On      |
| **Price increases** | Off     |
| **Out of stock**    | Off     |
| **Back in stock**   | On      |

**Minimum change** filters small price moves. A price change notifies when it reaches either the percentage or the amount in the store's currency. The default is 5% with no amount. Set a field to 0 to turn it off; with both at 0, every price change notifies. Stock changes always notify when their switch is on.

Every price and stock change is still recorded and shown on the Price Drops page and Market tab, whatever the notification settings are.

## Fix pages that need attention

Checks that fail, are blocked by a bot check (CAPTCHA), or find no price show as **Needs attention** on **Price Drops**, and the Inbox gets one message that lists them when a product newly runs into a problem. The message closes on its own once every store page reads fine again.

Select the **Blocked**, **Failed**, or **Unavailable** mark in the table (or the window button next to a store in the knife's sources) to open the store page in a visible browser window. Pass the bot check, or settle a cookie banner, age prompt, or region choice yourself, then select **Done**. BladeVault keeps that window's cookies for the store, so later checks get through, and checks the price again right away. The window opens on the computer that runs BladeVault, so this works with the desktop app or a local server, not with a server in Docker.

## How checks are scheduled

Open **Settings → Price monitoring** to control automatic checks:

- **Check prices automatically** turns scheduled checks on or off. **Check now** works either way.
- **Skip sold knives** leaves sold knives out in Auto mode.
- **How often** — **Once daily**, **Twice daily**, **Every 12 hours**, or **Custom** with an interval in hours.
- **Only check between** limits checks to set hours, in the server's time zone.

BladeVault never hits one store with several requests at once. Each store is checked one product at a time, and its checks are spread evenly over the chosen interval; different stores are checked in parallel. **Pacing** sets the minimum pause between two checks at one store, with a separate, longer pause shared by all Amazon marketplaces.

The pace adapts by itself: a store that answers slowly, rate-limits, or shows a bot check is slowed down or paused, and speeds up again after successful checks. The **Stores** table shows each store's current pace, how long a full pass takes, and any pause.

Prices are compared only within one currency. Implausible jumps are confirmed with a second reading before they are recorded.

## Optional AI assistance

**Settings → Price monitoring → AI assistance** can use any OpenAI-compatible endpoint, such as a cloud provider, a gateway, or a local Ollama or LM Studio server. Price monitoring works fully without it, and nothing is sent to an AI service while **Use AI** is off.

1. Turn on **Use AI**.
2. Enter the **Base URL**, for example `https://api.openai.com/v1` or `http://localhost:11434/v1` for Ollama.
3. Enter an **API key** if the endpoint needs one. Local servers usually do not.
4. If the gateway needs extra headers, enter them as a JSON object in **Custom headers**. OpenCode Go, for example, rejects requests without a session header: `{"x-opencode-session": "bladevault"}`. Custom headers are saved with the other settings, so keep keys in the API key field.
5. Select **Discover models** and choose a model, or type a model ID.
6. Select **Test connection** to confirm that the model reads a sample price.

Three features use it:

- **Read prices the page parsers miss** sends a trimmed part of the product page (title, price, and stock elements) at most once a day per product. It also runs when the parsers found a price without a currency or with an unusable amount. A price the model returns is used only if it appears on the page as written.
- **Resolve check errors** steps in when a check cannot read a price (no price, no currency, an unusable amount, or a slow page). AI works the product page in the monitoring browser, one step at a time and at most six steps: it can wait for content, scroll, accept or reject a cookie banner, confirm an age prompt, close a pop-up, pick a variant or region, open the store's own canonical, AMP, or Shopify product data, and read the price. With **The model reads images** on, it can also read a price from a screenshot of the page. A price read by AI must appear on the page as written (or, from a screenshot, be read with very high confidence) and then passes the usual checks. Steps that let the page parsers find the price are remembered for the store and replayed first on later checks, without AI; a remembered recipe that stops working is forgotten. After an HTTP error, a timeout, a network error, or a redirect, AI also chooses how to recover within fixed limits: reset the store's saved cookies after a block, load the store in the browser instead of plain HTTP for 7 days, wait longer before checking the product again, or pause a product whose page is gone after repeated failures. The steps it took and its explanation appear in the check history. AI runs at most once a day per product, shared with price reading. It never buys, signs in, fills forms, leaves the store's site, or solves a bot check, and never retries a blocked store sooner than the normal backoff.
- **Pacing advisor** reviews each store's check statistics once a day, or after a store blocked checks twice, and may slow a store down, pause it, or set quiet hours within fixed limits. Only store host names and statistics are sent. AI can never speed a store up or shorten a pause after a bot check, and its advice lasts 48 hours. **Review pacing now** runs a review on demand.

The API key is stored next to the vault in its private control folder, outside backups, and the settings page only shows its last four characters. Docker and Helm can provide it with `BLADEVAULT_PRICE_AI_API_KEY` instead.

## Keep checking with the desktop app closed

In the desktop app, **Settings → Price monitoring → Desktop app → Keep running in the background** keeps BladeVault in the menu bar or system tray when you close its window, so scheduled checks continue. The tray menu offers **Open BladeVault**, **Check prices now**, and **Quit**. Use **Quit** to stop BladeVault completely.

When BladeVault starts again after being closed, overdue products are checked at the normal pace, not all at once.

## Related

- [Your data](../reference/data.md) — where price history is stored and what backups include.
- [Docker and Podman](../installation/docker.md) and [Kubernetes with Helm](../installation/helm.md) — time zone and price monitoring settings for servers.
- [Desktop app](../installation/desktop.md) — the tray and background mode.
