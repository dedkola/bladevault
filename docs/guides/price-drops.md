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

**Minimum change** filters small price moves: a price change notifies only when it moves by at least this percentage of the previous price. The default is 5%. Set it to 0 to be notified about every price change. Stock changes always notify when their switch is on.

Every price and stock change is still recorded and shown on the Price Drops page and Market tab, whatever the notification settings are.

With AI connected, **Confirm price changes** (see [Optional AI assistance](#optional-ai-assistance)) checks a change against the store page before it notifies you, and **Daily summary in the Inbox** adds one short AI summary a day.

## Fix pages that need attention

Checks that fail, are blocked by a bot check (CAPTCHA), or find no price, and store pages where AI doubts the price the page parser read (**Spot-check page readings**), show as **Needs attention** on **Price Drops**, and the Inbox gets one message that lists them when a product newly runs into a problem. The message closes on its own once every store page reads fine again.

Select the **Blocked**, **Failed**, or **Unavailable** mark in the table (or the window button next to a store in the knife's sources) to open the store page in a visible browser window. Pass the bot check, or settle a cookie banner, age prompt, or region choice yourself, then select **Done**. BladeVault keeps that window's cookies for the store, so later checks get through, and checks the price again right away. The window opens on the computer that runs BladeVault, so this works with the desktop app or a local server, not with a server in Docker.

## How checks are scheduled

Open **Settings → Price monitoring** to control automatic checks:

- **Check prices automatically** turns scheduled checks on or off. **Check now** works either way.
- **Skip sold knives** leaves sold knives out in Auto mode.
- **How often** — **Once daily**, **Twice daily**, **Every 12 hours**, or **Custom** with an interval in hours.
- **Only check between** limits checks to set hours, in the server's time zone.

BladeVault never hits one store with several requests at once. Each store is checked one product at a time, and its checks are spread evenly over the chosen interval; different stores are checked in parallel. A product that has never been checked does not wait for its turn in the spread: it gets its first reading as soon as the store's minimum pause allows. **Pacing** sets the minimum pause between two checks at one store, with a separate, longer pause shared by all Amazon marketplaces.

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

Models that reason before they answer (such as GLM, DeepSeek R1, or Qwen3) need more time and room than a short price answer suggests. BladeVault notices this on the first request that comes back empty, cut off, or too late, retries it once with the **Answer limit for reasoning models** (16,384 tokens by default) and at least 60 seconds, and gives that model the same room from then on. The limit caps the answer only, not the page sent. If the endpoint refuses it as above the model's own limit, BladeVault lowers it to 4,096 tokens for that model. **Test connection** says when a model reasons.

**AI usage** decides how much AI may work:

- **Limited** (the default) is for paid APIs and slow local models. **Requests per day** (200 by default) and **Tokens per day** (2,000,000 by default) cap AI per day, counted from midnight on the server; 0 turns a cap off. **AI per product at most every** (24 hours by default) is how long a product waits after AI worked on it. Once a cap is reached, AI stops until midnight and monitoring continues without it, and Other stores does not open store searches it cannot finish. **Test connection** never counts.
- **Unlimited (always run)** is for cheap or local models that can run all day. There are no daily caps and no per-product wait, so AI helps on every check that needs it. Only a product that failed three checks in a row waits a day before AI tries it again, and the wait ends after a successful check. Store pacing, Retry-After, and bot-check pauses still apply: stores, not tokens, set the pace.

**Page size AI reads** sets how much of a product page AI reads when it reads a price: 200 KB of cleaned HTML by default, from 8 to 1,000 KB. The price, offer, and stock elements come first, followed by the rest of the page without scripts, styles, comments, or most attributes. Models with a large context window handle 200–500 KB; a small local model needs about 8–16 KB. When AI works a page step by step to resolve a check error, each step reads at most 64 KB.

**AI activity** shows what AI did in the last 24 hours: how many requests it made for each task, how many failed, how long they usually took, how many tokens they used, the latest error, and today's requests and tokens against the Limited budget. The journal behind it keeps no page content, answers, or keys, and keeps 30 days.

Six features use it:

- **Read prices the page parsers miss** sends the cleaned product page, up to **Page size AI reads**, within the **AI usage** limits. It also runs when the parsers found a price without a currency or with an unusable amount. A price the model returns is used only if it appears on the page as written.
- **Resolve check errors** steps in when a check cannot read a price (no price, no currency, an unusable amount, or a slow page). AI works the product page in the monitoring browser, one step at a time and at most six steps: it can wait for content, scroll, accept or reject a cookie banner, confirm an age prompt, close a pop-up, pick a variant or region, open the store's own canonical, AMP, or Shopify product data, and read the price. With **The model reads images** on, it can also read a price from a screenshot of the page. A price read by AI must appear on the page as written (or, from a screenshot, be read with very high confidence) and then passes the usual checks. Steps that let the page parsers find the price are remembered for the store and replayed first on later checks, without AI; a remembered recipe that stops working is forgotten. After an HTTP error, a timeout, a network error, or a redirect, AI also chooses how to recover within fixed limits: reset the store's saved cookies after a block, load the store in the browser instead of plain HTTP for 7 days, wait longer before checking the product again, or pause a product whose page is gone after repeated failures. The steps it took and its explanation appear in the check history. Price reading and resolving share the per-product wait of **AI usage**. It never buys, signs in, fills forms, leaves the store's site, or solves a bot check, and never retries a blocked store sooner than the normal backoff.
- **Confirm price changes** checks a price change against the product page before it notifies you, and also checks a price that jumped far more than usual (below half or above three times the recent price) even when that change would not notify. AI gets the cleaned page (up to **Page size AI reads**), the old and new price, the knife's brand, name, and key specs (such as blade length, steel, and model number), and the store's host name; never the purchase price or notes. It answers whether the new price is the current price of exactly this product: the same variant and currency, for one item, and not a bundle, an accessory, a per-unit price, or a crossed-out price. When AI rejects the price with high confidence, the reading is kept in the history as unconfirmed, nothing notifies, the store keeps its last price, and the reason appears in the check history. A repeat of that price is checked again on later checks, and the old price coming back is not reported as a change. When AI is unavailable, unsure, or the daily budget is used up, changes notify as before. A price AI quotes in its reason must appear on the page as written; AI never sets a price. Confirming a change does not wait for the per-product wait of **AI usage**, but counts toward the daily caps.
- **Spot-check page readings** works with **AI usage** set to **Unlimited**. AI also checks the page parsers' readings: every reading on a product's first check, and every reading where the price changed. When AI is sure a reading is wrong, the store page is marked **AI doubts the price** under **Needs attention**, with AI's reason. The parser's price is kept, and the mark stays, with the page checked again on every check, until AI confirms the price, the price changes, or spot checks are turned off.
- **Daily summary in the Inbox** has AI write a short summary once a day, from 6:00 on, server time: the best current prices against what you paid, the last 24 hours' drops and restocks, store pages that need attention, and what AI did (prices it read, checks it worked through, readings it doubted). It appears in the Inbox under **System**, and each day's summary replaces the previous one, which moves to **Done**. Only knife names, store names, and prices are sent: no notes, photos, links, or keys. A summary that quotes a price not in that data is discarded. Nothing is written on a day without news, and a failed attempt is retried an hour later (the next day when the daily budget is used up).
- **Pacing advisor** reviews each store's check statistics once a day, or after a store blocked checks twice, and may slow a store down, pause it, or set quiet hours within fixed limits. Only store host names and statistics are sent. AI can never speed a store up or shorten a pause after a bot check, and its advice lasts 48 hours. **Review pacing now** runs a review on demand.

The API key is stored next to the vault in its private control folder, outside backups, and the settings page only shows its last four characters. Docker and Helm can provide it with `BLADEVAULT_PRICE_AI_API_KEY` instead.

## Let AI supervise monitoring

**Settings → Price monitoring → AI assistance → AI supervisor** lets AI look over all of price monitoring and decide what needs attention. It needs [AI assistance](#optional-ai-assistance) connected.

| Mode        | What it does                                                         |
| ----------- | -------------------------------------------------------------------- |
| **Off**     | The default. AI does not supervise.                                  |
| **Observe** | AI plans what it would do and records it, without changing anything. |
| **Act**     | AI does what it planned, within fixed limits.                        |

The supervisor runs every 10 minutes with **Unlimited** AI usage and every hour with **Limited**, and **Run now** starts a run at once. Each run, AI sees every monitored product (knife name, store, status, when it was last checked and how it failed), each store's pace and pauses, how many products are fresh, and the AI budget. It never sees product links, what you paid, notes, or keys. It can:

- **Check first**: move up to 25 overdue, stale, or failing products to the front of their store's queue. A product blocked by a bot check still waits out its backoff.
- **Retry with AI**: let AI read or work the page of up to 10 failing products on their next check.
- **Change how a page loads**: switch up to 5 products to the browser, plain HTTP, or back to automatic.
- **Pause**: stop up to 3 products whose page failed at least 5 checks in a row and seems gone (not found, HTTP 404 or 410, or a redirect; never timeouts, server errors, or bot checks). Resume them in the knife's **Price monitoring** section.
- **Look on other stores**: search again for up to 5 knives on other stores, when [Other stores](#find-knives-at-other-stores-with-ai) is on.

Every action is checked before it runs, and actions that break the rules are refused and recorded with the reason. The supervisor can change the order of checks but not their pace: each store is still checked one product at a time, and store pauses, Retry-After, and bot-check pauses still apply. It never solves a bot check. The latest run and its summary appear under **AI supervisor**. Runs are kept for 30 days.

## Find knives at other stores with AI

A knife's own store is often sold out. **Settings → Price monitoring → Other stores** lets AI look for every monitored knife at other stores and add the listings it finds as price sources. Amazon is the first store on the list. It needs [AI assistance](#optional-ai-assistance) connected: with **Use AI** off, or without a base URL and model, nothing is searched.

1. Connect AI in **AI assistance**.
2. Turn on **Look for knives at other stores**.
3. Keep **Amazon** on and choose the marketplace, for example `amazon.com` or `amazon.de`.

For each knife, AI does the work in three steps:

- **Find** — BladeVault opens the store's search for the knife's brand, name, and model number, and AI picks the listing that sells exactly this knife. Sheaths, sharpeners, parts, and other models never count.
- **Check** — BladeVault opens that product page, and AI confirms it is the same knife. A different steel, blade length, or lock is a different knife.
- **Parse** — the product becomes a source marked **Found by AI** and is checked like any other source. The Amazon parser reads the price, and AI reads it or resolves the check when the parser cannot (with **Read prices the page parsers miss** and **Resolve check errors** on).

Searches cover every knife that price monitoring covers, including knives without a product link, and skip knives that already have an Amazon source. They run with scheduled checks, one knife at a time, and share Amazon's pace: a due Amazon price check always goes first, and a bot check pauses both. AI receives the knife's brand, name, and specs and the store's listing titles, never what you paid, notes, or photos.

The section lists recent results. A knife that is not found is searched again after 30 days, and a failed search after a few hours. **Search again for missing** searches those knives at the next free slot. A found listing is never replaced: remove its source to stop monitoring it, and it is not added again.

## Keep checking with the desktop app closed

In the desktop app, **Settings → Price monitoring → Desktop app → Keep running in the background** keeps BladeVault in the menu bar or system tray when you close its window, so scheduled checks continue. The tray menu offers **Open BladeVault**, **Check prices now**, and **Quit**. Use **Quit** to stop BladeVault completely.

When BladeVault starts again after being closed, overdue products are checked at the normal pace, not all at once.

## Related

- [Your data](../reference/data.md) — where price history is stored and what backups include.
- [Docker and Podman](../installation/docker.md) and [Kubernetes with Helm](../installation/helm.md) — time zone and price monitoring settings for servers.
- [Desktop app](../installation/desktop.md) — the tray and background mode.
