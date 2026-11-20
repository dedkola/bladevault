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

Open **Price Drops** in the sidebar. From top to bottom the page shows:

- **Header** — whether automatic checks are running, waiting for the next check, or outside checking hours, with the time of the last successful check. **Check all now** queues every monitored source. It is unavailable while **Check prices automatically** is off; **Check now** on a knife or store still works then.
- **AI supervisor** — appears when AI is connected (see [Let AI supervise monitoring](#let-ai-supervise-monitoring)): its mode, latest summary, coverage of monitored sources, what it did in its last run, and stores that need you to solve a bot check.
- **Monitoring status** — counts of sources checked in the last 24 hours, drops, rises, out of stock, sources that need attention, and sources still waiting for their first check. Below the counts, a timeline pins each knife where it was last checked over the past 24 hours and again where its next check is due. Group the lanes **By result** or **By store**. Knives already due wait at **Now** and are checked one at a time per store. Select a pin to open the knife; a pin for several knives lists them.
- **Checks per hour** and **Round** — checks started in each of the last 24 hours, colored by what they found, next to the check interval, number of stores, paused stores, failed checks in 24 hours, and the oldest result.
- **The table** — every monitored store listing, with the price now, the latest change in money and percent, and the difference from what you paid. Switch between tabs:
  - **All** — every monitored source.
  - **Changes** — drops, increases, and out-of-stock sources together.
  - **Drops** and **Increases** — sources whose latest price change in the last 30 days is still the current price.
  - **Out of stock** — sources that currently show the knife as unavailable.
  - **Needs attention** — failed, blocked, unavailable, or doubtful readings, with when each will be checked next, such as **next in 3 hours**, **due now**, or **overdue 9 h**. Sources that have never been checked are not problems: they show as **Waiting** in **All** and in their own timeline lane until their first check.
  - **Recently monitored** — the 30 latest checks.
- **Side panel** — the selected knife's best current price, price chart, and sources, each with **Check now**. With AI connected, **Supervisor activity** below it lists every action, with the day for anything older than today.

Percent changes keep one decimal below 10%, so a 0.3% move does not read as 0%. Times follow **Settings → Time format** (12-hour or 24-hour) and add the date when they are not today.

### Small moves and fluctuating prices

Price Drops counts a price change only when it reaches the **Minimum change** from [notifications](#get-notified-in-the-inbox) (5% by default), so stores that convert prices from another currency do not fill the page with tiny moves:

- A smaller move shows as **No change** with a muted hint such as **−0.3%**. It does not appear under drops or increases, in their counts, or in the Dropped and Rose lanes of the status timeline.
- Small moves add up. Once the price has drifted by the Minimum change from where it started in the last 30 days, or from its last counted change, it counts as a drop or an increase.
- When the price comes back to about a price it had earlier in the last 30 days (for example, it rose in the morning and fell back in the afternoon), the moves cancel out and the listing shows **Fluctuating** instead of a fresh drop or rise.

Every move is still recorded: the chart, the Market tab's latest changes, and notifications are unaffected. Set the Minimum change to 0 to count every price change.

## Check one knife's market

Open a knife and select the **Market** tab. It shows:

- **Best price now** across its sources, next to **You paid** when a purchase price is stored. When the stores show another currency than the purchase price, a note such as **UAH price** under the best price says they are not compared.
- A price chart for 7 days up to all history, with each store as its own line and out-of-stock periods marked.
- **Sources** with each store's status: **Checked**, **Price unavailable**, **Out of stock**, **Failed**, **Blocked**, or **Not checked yet**.
- **Latest changes** for the knife.

Market prices are information only. They never change the purchase price stored in the knife's specifications.

## Get notified in the Inbox

New changes appear in the **Inbox** under **Prices** and in the header bell. Each notification shows the knife, the store, the old and new price, and the change in money and percent. When they can be compared in the same currency, it also shows how the price stands against what you paid and the lowest price seen at that store. Use **Market** to open the knife's Market tab, **Store page** to open the product page, **Mark read**, **Snooze**, or **Dismiss**.

- One store keeps one notification per kind. A further drop at the same store updates that notification and marks it unread again instead of adding another.
- A change the other way closes the notification on its own: a price increase closes an open drop, and a restock closes an open out-of-stock notice.
- **Snooze** hides a notification until tomorrow, in 3 days, a week, or a month; it then comes back unread under **Open**, with the latest change if the store changed again meanwhile. **Show now** brings it back early from **Snoozed**.
- The same menu can **mute this store** for the knife for a week, a month, or 3 months: checks continue, but that store sends no new notifications until then. A muted store shows in the knife's price monitoring editor and Market tab, where **Unmute** ends it early.
- Under **Prices**, **Mark all read** and **Dismiss all** act on every open price notification at once. Dismissed notifications can be moved back to the inbox one by one from **Done**.
- Dismissed and closed notifications stay under **Done** for 90 days.

Choose which changes notify you in **Settings → Price monitoring → Notifications**:

| Setting             | Default |
| ------------------- | ------- |
| **Price drops**     | On      |
| **Price increases** | Off     |
| **Out of stock**    | Off     |
| **Back in stock**   | On      |

**Minimum change** filters small price moves: a price change notifies only when it moves by at least this percentage of the previous price. The default is 5%. The same threshold decides which moves count as a change on the Price Drops page (see [Small moves and fluctuating prices](#small-moves-and-fluctuating-prices)). Set it to 0 to be notified about every price change. Stock changes always notify when their switch is on.

**Minimum amount** also ignores price changes smaller than this many units of the price's own currency, for example 3 to skip moves under $3, €3, or ₴3. A change must pass both the percentage and the amount. The default is 0 (off).

**Always notify about a new lowest price** (off by default) lets a drop to the lowest price a store has shown for the knife notify even when it is below the minimum percentage. It still needs **Price drops** on, and the minimum amount still applies.

### Alerts for one knife

A knife's price monitoring editor (edit mode) and its **Market** tab have **Alerts for this knife**:

- **Mute this knife** stops new notifications for it. Checks, history, and the Price Drops page carry on, and a later change the other way still closes an open notification.
- **Target price** makes drops notify only at or below that price. A drop that reaches the target notifies even when it is smaller than the minimum change; later drops below the target follow the usual minimums. Stores that sell in another currency are not compared with the target.
- **Only below what I paid** makes drops notify only when the new price is under the knife's purchase price. Without a purchase price in the same currency, drops notify as usual.

These rules apply to price drops; stock and increase notifications follow the settings above. They are stored in the vault, so backups and restores keep them.

Every price and stock change is still recorded and shown on the Price Drops page and Market tab, whatever the notification settings are.

With AI connected, **Confirm price changes** (see [Optional AI assistance](#optional-ai-assistance)) checks a change against the store page before it notifies you, and **Daily summary in the Inbox** adds one short AI summary a day.

## Fix pages that need attention

Checks that fail, are blocked by a bot check (CAPTCHA), or find no price, and store pages where AI doubts the price the page parser read (**Spot-check page readings**), show as **Needs attention** on **Price Drops**, and the Inbox gets one message that lists them when a product newly runs into a problem. The message closes on its own once every store page reads fine again.

Select the **Blocked**, **Failed**, or **Unavailable** mark in the table (or the window button next to a store in the knife's sources) to open the store page in a visible browser window. Pass the bot check, or settle a cookie banner, age prompt, or region choice yourself, then select **Done**. BladeVault keeps that window's cookies for the store, so later checks get through, and checks the price again right away. The window opens on the computer that runs BladeVault, so this works with the desktop app or BladeVault running on your computer. On a Docker or Helm server, the marks and window buttons say so instead of opening a window you cannot see.

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
4. If the gateway needs extra headers, enter them as a JSON object in **Custom headers**. OpenCode Go, for example, rejects requests without a session header: `{"x-opencode-session": "bladevault"}`. Custom headers are saved with the other settings and included in backups, so keep keys and tokens in the API key field.
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

**Desktop notifications for price drops** (off by default, in the same section) also shows price drops and restocks as system notifications while the BladeVault window is hidden, minimized, or closed to the tray. Only changes that reach the Inbox notify, after the window went away; several at once arrive as one summary. Clicking a notification opens the knife's Market tab, or the Inbox for a summary. Nothing is shown while App Lock is locked.

## Use price data from an AI client

BladeVault's [MCP tools](../reference/mcp.md#price-monitoring-tools) let an AI client such as Claude Desktop or Codex read monitored knives, recent drops and restocks, price history, and pages that need attention. With write access turned on in **Settings → AI / MCP**, the client can also change a knife's monitoring mode, add, pause, resume, or remove store URLs after a preview, and ask for **Check now**. Checks it requests wait for each store's normal pace, like the ones you start yourself.

## Related

- [Model Context Protocol (MCP)](../reference/mcp.md) — connect an AI client and review what it can change.
- [Your data](../reference/data.md) — where price history is stored and what backups include.
- [Docker and Podman](../installation/docker.md) and [Kubernetes with Helm](../installation/helm.md) — time zone and price monitoring settings for servers.
- [Desktop app](../installation/desktop.md) — the tray and background mode.
