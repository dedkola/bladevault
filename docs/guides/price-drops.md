# Watch market prices with Price Drops

Price Drops checks the stores that sell the knives in your collection and records every price and stock change. Open **Price Drops** in the main navigation to see what changed, open a knife's **Market** tab for its price history, and find new drops and restocks in the **Inbox** under **Prices**.

Price monitoring needs the BladeVault server: it works in the desktop app, Docker, Helm, and a source checkout, but not in the static web app.

## Which knives are monitored

Every knife starts in **Auto** mode. In Auto, a knife is monitored when it has a stored regular price above 0 and a product link (**Source URL**). Its product link becomes its first store source automatically.

| Mode               | What it does                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| **Auto**           | Monitors the knife when a regular price is stored. Sold knives are skipped unless you change that. |
| **Always monitor** | Monitors the knife even without a stored price, and even when it is marked as sold.                |
| **Never monitor**  | Leaves the knife out of scheduled checks. **Check now** still takes a single reading.              |

Change the mode for one knife without leaving its page:

1. Open the knife and select the **Market** tab (or select the knife on **Price Drops**).
2. Select **Manage sources**. It explains whether the knife is monitored and why.
3. Choose **Auto**, **Always monitor**, or **Never monitor**.

The same controls are under **Price monitoring** when you edit the knife.

## Add more stores for a knife

A knife can have up to 10 store sources from any store, including Amazon. Each source keeps its own history and status.

Amazon pages are checked like any other store's, and all Amazon marketplaces share one pace. The AI features of Price Drops leave them alone: AI does not read, verify, or troubleshoot Amazon prices, and **Other stores** does not search Amazon. Amazon sources that an earlier version removed come back with their price history when the knife's product link is still on Amazon.

1. Open the knife's **Market** tab and select **Manage sources** (or select **Edit** and scroll to **Price monitoring**).
2. Enter a product page in **Add store URL** and select **Add**.
3. Use **Pause** or **Resume** to stop or restart checks for one source, and **Remove** to stop monitoring it.

A removed source keeps its recorded history, which still appears in charts as a removed source. Changing the knife's **Source URL** moves its automatic source to the new link.

Each source also offers **How to load this page**. **Auto (learned per store)** is the right choice for almost every store; **Always browser** and **Always plain HTTP** are for stores where the automatic choice keeps failing.

## Read the Price Drops page

Open **Price Drops** in the sidebar. From top to bottom the page shows:

- **Header** — whether automatic checks are running, waiting for the next check, or outside checking hours, with the time of the last successful check. **Check all now** queues every monitored source. It is unavailable while **Check prices automatically** is off; **Check now** on a knife or store still works then.
- **AI supervisor** — appears when AI is connected (see [Let AI supervise monitoring](#let-ai-supervise-monitoring)): its mode, latest summary, coverage of monitored sources, what it did in its last run, and stores that need you to solve a bot check.
- **Monitoring status** — counts of sources checked in the last 24 hours, drops, rises, out of stock, sources that need attention, and sources still waiting for their first check. Below the counts, a timeline pins each knife where it was last checked over the past 24 hours and again where its next check is due. Group the lanes **By result** or **By store**. Knives already due wait at **Now** and are checked one at a time per store. Select a pin to open the knife; a pin for several knives lists them. Select **Hide timeline** to keep only the counts; the page remembers the choice.
- **The table** — every monitored store listing, with the price now, the latest change in money and percent, and the difference from the regular price. Switch between tabs:
  - **All** — every monitored source.
  - **Changed** — drops, increases, and out-of-stock sources together.
  - **↓ Down** — everything you can buy cheaper now: in-stock sources below the knife's regular price, including a store that was only just added, and sources whose latest price cut in the last 30 days is still the current price. The biggest saving is listed first.
  - **↑ Up** — sources whose latest price rise in the last 30 days is still the current price.
  - **Restocked** — sources that came back in stock in the last 7 days, marked like **Restocked · 2 d ago**.
  - **Out of stock** — sources that currently show the knife as unavailable, with how long, like **Out of stock · 41 d**.
  - **Needs attention** — failed, blocked, unavailable, or doubtful readings. They keep their last known price, shown muted with its date (**as of Nov 3**), and show when each is checked next, such as **next in 3 hours**, **due now**, or **overdue 9 h**. Sources that have never been checked are not problems: they show as **Pending** in **All** and in their own timeline lane until their first check.
  - **Recently checked** — the 30 latest checks.
  - **Supervisor** — with AI connected, the supervisor's recent runs as a timeline, newest first, each with what started it (changes, the schedule, or **Run now**). Select a run to see its summary, coverage, the changes since the run before, and every action in a table with the knife, store, reason, and result; repeated actions at one store collapse into one row you can expand. Select a knife name to open it in the table.
- **Side panel** — the selected knife's price details, the same as its Market tab (see below), including **Latest changes**, **Check all sources**, **Manage sources**, and each store's **Check now** and check history.

To find a knife, search by brand, name, model number, steel, or store, or pick a store. Select a column header (**Price now**, **Change**, **vs regular**, **Checked**) to sort by it, and select it again to reverse or reset the order. **vs regular** shows the difference in money and percent. Knives that share a name show their model number, steel, and handle so you can tell them apart. **Group by knife** (on by default) shows one row per knife with its best price; expand it to see each store, or turn it off for one row per store.

The open tab and selected knife stay in the address (`?section=` and `?knife=`), so a link opens the same view; the page also remembers the last tab and the chart range in this browser.

Select a knife to see its best current price, price chart, and sources in the side panel; on a phone it opens as a sheet. Each row also has **Check now**, **Store page**, **Market tab**, and, for listings that need attention, **Solve in browser**.

Tick rows to act on several at once: **Check now**, **Pause** (paused listings stop being checked; resume them in the knife's edit mode), or **Set mode** to Auto, Always monitor, or Never monitor. BladeVault asks first before changing five or more.

The **Price Drops** link in the navigation shows how many price notifications are unread. If the page cannot refresh, it says how old the shown data is and offers **Retry**.

**Check all now** queues every monitored source and shows its progress, such as "34 of 221 checked", until the queue is done; **Check now** on a source or knife checks just that one.

Percent changes keep one decimal below 10%, so a 0.3% move does not read as 0%. Times follow **Settings → Time format** (12-hour or 24-hour) and add the date when they are not today.

### Small moves and fluctuating prices

Price Drops counts a price change only when it reaches the **Minimum change** from [notifications](#get-notified-in-the-inbox) (5% by default), so stores that convert prices from another currency do not fill the page with tiny moves:

- A smaller move shows as **Unchanged** with a muted hint such as **−0.3%**. It does not appear under drops or increases, in their counts, or in the Down and Up lanes of the status timeline.
- Small moves add up. Once the price has drifted by the Minimum change from where it started in the last 30 days, or from its last counted change, it counts as a drop or an increase.
- When the price comes back to about a price it had earlier in the last 30 days (for example, it rose in the morning and fell back in the afternoon), the moves cancel out and the listing shows **Fluctuating** instead of a fresh drop or rise.

Every move is still recorded: the chart, the Market tab's latest changes, and notifications are unaffected. Set the Minimum change to 0 to count every price change.

## Check one knife's market

Open a knife and select the **Market** tab. It shows:

- **Best price now** across its sources, the store that has it, linked to its product page, and **Regular price** when a regular price is stored. When the stores show another currency than the regular price, a note such as **UAH price** under the best price says they are not compared.
- **Lowest seen** and **Highest seen** in-stock prices, **Tracking since** (the first reading), and **Now vs regular price**: the best current price minus the regular price, in money and percent. These cover the whole history, whatever range the chart shows.
- A price chart for 7 days up to all history, with each store as its own line and out-of-stock periods shaded. When the range reaches back before the first reading, the chart starts at that reading and says **Tracking since** that date. Markers show price drops and increases, stock changes, and the lowest price seen; with more than one store, the legend also names the store that had the lowest price. Hover over the chart for every store's price at that moment, with the cheapest one marked. Stores that show a price in another currency than the chart are left out and noted below it, for example "1 store in EUR not shown".
- **Sources** with each store's status: **Checked**, **Price unavailable**, **Out of stock**, **Failed**, **Blocked**, or **Not checked yet**, and **Low stock** or **Preorder** when the store says so. **Check all sources** checks every store of the knife now.
- **Latest changes** for the knife.

### Check history

Select the history button next to a store to see its last 30 checks, newest first: when and why each check ran (scheduled, **Check now**, or a retry), whether it read a price, failed, or was blocked, how the page was loaded (HTTP, browser, or AI), the HTTP status, how long it took, the price and stock it read, and the error, if any. Checks where AI worked the page list the steps it took under **AI steps**. A price that AI could not confirm is marked **AI unconfirmed**: it is kept in the history but never becomes the store's price, and the chart shows it as a dashed hollow marker instead of part of the line.

Market prices are information only. They never change the regular price stored in the knife's specifications.

## See market prices in your collection

Your collection can show each knife's best current price and what happened to it, without opening the Market tab:

- **Card detail** — open **Settings → Appearance → Card fields** and select **Market price** under **Market**. Cards then show a small pill such as `$89.00 · ↓ 12%`, `$150.00 · Back in stock`, `Out of stock`, or `$99.00 · Below regular`.
- **Table column** — in the collection's table or list view, open **Columns** and select **Market**. Sort by it to bring recent drops, restocks, and prices below regular price to the top. In Ledger, the **Market price** card field is its list column.
- **Filter** — choose **Market** under **Filters** (or type `Market` in the search bar on Modern, Ledger, and Shelf) and pick **Price dropped recently**, **Back in stock recently**, **Out of stock**, **Below regular price**, **Monitored**, or **Not monitored**. Picking several shows knives that match any of them. [Smart Collections](smart-collections.md) save these conditions, so a "Below regular price" view stays current as prices change.

A drop counts as recent for 30 days while the price still sits there, using the same **Minimum change** as the Price Drops page, so small wobbles and prices that bounce back are left out; a restock counts for 7 days. **Below regular price** compares the lowest in-stock price with the regular price when both are in the same currency. Paused store links are left out. The collection picks up new prices after checks finish and every few minutes while BladeVault is open.

Market prices need the BladeVault server, so the static web demo does not show them.

## Export price history to CSV

Select **Export CSV** on a knife's **Market** tab or in the Price Drops side panel to download that knife's full price history. **Export all** in the Price Drops header downloads the history of every knife with recorded prices. In the desktop app, a save dialog asks where to put the file.

Each row is one price state at one store: when it was first seen (`observed_at`), when a check last confirmed it (`last_seen_at`), how many checks saw it, the knife's brand, name and ID, the store and product URL, the price in normal units (for example `129.99`), currency, availability, how the price was read (`extraction_method`), and the AI review (`confirmed` or `unconfirmed`) when AI checked the reading.

The file contains only what stores published. The regular price, notes, and other collection details are left out, so you can share it. Text that a spreadsheet could run as a formula starts with an apostrophe. The file is UTF-8, so Excel shows names such as Böker correctly.

The export is also available from `/api/prices/export` while the app is unlocked:

- `kind=events` exports price changes and stock changes instead of price states, with the previous and new price, the change, and the change in percent.
- `knifeId=<id>` limits the export to one knife.
- `range=7d`, `1m`, `3m`, `6m` or `1y` limits it to recent history. Price states include the state each store showed when the range began, like the chart. The default is all history.

The static web app has no price monitoring, so it has no export.

## Get notified in the Inbox

New changes appear in the **Inbox** under **Prices** and in the header bell. Each notification shows the knife, the store, the old and new price, and the change in money and percent. When they can be compared in the same currency, it also shows how the price stands against the regular price and the lowest price seen at that store. Use **Market** to open the knife's Market tab, **Store page** to open the product page, **Mark read**, **Snooze**, or **Dismiss**.

- One store keeps one notification per kind. A further drop at the same store updates that notification and marks it unread again instead of adding another.
- A change the other way closes the notification on its own: a price increase closes an open drop, and a restock closes an open out-of-stock notice.
- A knife's stores count as one item. **Out of stock** notifies only when no store you monitor has the knife, and **Back in stock** when the first store has it again, which also closes the knife's out-of-stock notice. A store added later, such as one **Other stores** found, counts as a price drop when its first price is below every other store selling the knife, and as back in stock when the other stores are out of stock. These show on the Price Drops page and the knife's chart too.
- **Snooze** hides a notification until tomorrow, in 3 days, a week, or a month; it then comes back unread under **Open**, with the latest change if the store changed again meanwhile. **Show now** brings it back early from **Snoozed**.
- The same menu can **mute this store** for the knife for a week, a month, or 3 months: checks continue, but that store sends no new notifications until then. A muted store shows in the knife's price monitoring editor and Market tab, where **Unmute** ends it early.
- Under **Prices**, **Mark all read** and **Dismiss all** act on every open price notification at once. Dismissed notifications can be moved back to the inbox one by one from **Done**.
- Dismissed and closed notifications stay under **Done** for 90 days.

Choose which changes notify you in **Settings → Notifications → Price drops & stock**:

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
- **Only below regular price** makes drops notify only when the new price is under the knife's regular price. Without a regular price in the same currency, drops notify as usual.

These rules apply to price drops; stock and increase notifications follow the settings above. They are stored in the vault, so backups and restores keep them.

Every price and stock change is still recorded and shown on the Price Drops page and Market tab, whatever the notification settings are.

With AI connected, **Confirm price changes** (see [Optional AI assistance](#optional-ai-assistance)) checks a change against the store page before it notifies you, and **Daily summary in the Inbox** adds one short AI summary a day.

## Fix pages that need attention

Checks that fail, are blocked by a bot check (CAPTCHA), or find no price, and store pages where AI doubts the price the page parser read (**Spot-check page readings**), show as **Needs attention** on **Price Drops**, and the Inbox gets one message that lists them when a product newly runs into a problem. The message closes on its own once every store page reads fine again.

Select **Solve** next to a **Blocked** store, or **Fix** next to a **Failed** or **Unavailable** one, in the table (or the window button next to a store in the knife's sources) to open the store page in a visible browser window. Pass the bot check, or settle a cookie banner, age prompt, or region choice yourself, then select **Done**. BladeVault keeps that window's cookies for the store, so later checks get through, and checks the price again right away. The window opens on the computer that runs BladeVault, so this works with the desktop app or BladeVault running on your computer. On a Docker or Helm server, the marks and window buttons say so instead of opening a window you cannot see.

A store page that has been out of stock for 60 days or more, or whose page is gone (the store answers "not found"), also shows under **Needs attention**, and in the knife's sources, with a hint that the listing may be discontinued. Select **Pause** to stop checking it, or **Add another store** to add a different store for the knife. A page that is not found three checks in a row is paused automatically.

## How checks are scheduled

Open **Settings → Price monitoring** to control automatic checks:

- **Check prices automatically** turns scheduled checks on or off. **Check now** works either way.
- **Skip sold knives** leaves sold knives out in Auto mode.
- **How often** — **Once daily**, **Twice daily**, **Every 12 hours**, or **Custom** with an interval in hours.
- **Only check between** limits checks to set hours, in the server's time zone.
- **Check long out-of-stock pages once a day** (on by default) checks a page that has been out of stock for two weeks or more at most once a day, so a restock still shows within a day while stores get fewer requests. **Check now** and **Check all now** still check it right away.

BladeVault never hits one store with several requests at once. Each store is checked one product at a time, and its checks are spread evenly over the chosen interval; different stores are checked in parallel. A product that has never been checked does not wait for its turn in the spread: it gets its first reading as soon as the store's minimum pause allows. **Pacing** sets the minimum pause between two checks at one store.

The pace adapts by itself: a store that answers slowly, rate-limits, or shows a bot check is slowed down or paused, and speeds up again after successful checks. The **Stores** table shows each store's current pace, how many of its products are checked only once a day because they have been out of stock for a long time, how long a full pass takes, and any pause. Each store has these actions:

- **Resume now** appears while a store is paused after a bot check or repeated errors and lets its next check start right away. The store may block again; if it does, it pauses for longer.
- **Check now** (the refresh button) queues every product at that store. They run at the store's minimum pause, not spread over the day.
- **Pause** stops scheduled checks at the whole store until you select **Resume**. Check now on a knife still works there.
- **Reset saved cookies** (the cookie button) forgets the cookies BladeVault kept for the store, for example when a stale session keeps getting blocked. A bot check you solved there may have to be solved again.

Prices are compared only within one currency. Implausible jumps are confirmed with a second reading before they are recorded.

## Optional AI assistance

Price monitoring can use any OpenAI-compatible endpoint, such as a cloud provider, a gateway, or a local Ollama or LM Studio server. Price monitoring works fully without it, and nothing is sent to an AI service while **Use AI** is off. The connection is set in **Settings → AI / MCP → AI connection for price drops**; what AI does is set in **Settings → Price monitoring → AI assistance**.

1. Turn on **Use AI** in **Settings → Price monitoring → AI assistance**.
2. Open **Settings → AI / MCP**. Under **AI connection for price drops**, enter the **Base URL**, for example `https://api.openai.com/v1` or `http://localhost:11434/v1` for Ollama.
3. Enter an **API key** if the endpoint needs one. Local servers usually do not.
4. If the gateway needs extra headers, enter them as a JSON object in **Custom headers**. OpenCode Go, for example, rejects requests without a session header: `{"x-opencode-session": "bladevault"}`. Custom headers are saved with the other settings and included in backups, so keep keys and tokens in the API key field.
5. Select **Discover models** and choose a model, or type a model ID.
6. Select **Test connection** to confirm that the model reads a sample price.

Models that reason before they answer (such as GLM, DeepSeek R1, or Qwen3) need more time and room than a short price answer suggests. BladeVault notices this on the first request that comes back empty, cut off, or too late, retries it once with the **Answer limit for reasoning models** (16,384 tokens by default) and at least 60 seconds, and gives that model the same room from then on. The limit caps the answer only, not the page sent. If the endpoint refuses it as above the model's own limit, BladeVault lowers it to 4,096 tokens for that model. **Test connection** says when a model reasons.

Planning tasks (the [AI supervisor](#let-ai-supervise-monitoring), the **Pacing advisor**, and the **Daily summary in the Inbox**) weigh many products or stores at once, so the model may reason before it answers: they start with the **Answer limit for reasoning models** and wait up to 6 minutes. Everything else (reading a price, working a page, confirming a change, searching other stores) asks OpenCode models to answer without reasoning, which keeps those frequent requests fast. Other endpoints answer as the model is set up.

**AI usage** decides how much AI may work:

- **Limited** (the default) is for paid APIs and slow local models. **Requests per day** (200 by default) and **Tokens per day** (2,000,000 by default) cap AI per day, counted from midnight on the server; 0 turns a cap off. **AI per product at most every** (24 hours by default) is how long a product waits after AI worked on it. Once a cap is reached, AI stops until midnight and monitoring continues without it, and Other stores does not open store searches it cannot finish. **Test connection** never counts.
- **Unlimited (always run)** is for cheap or local models that can run all day. There are no daily caps and no per-product wait, so AI helps on every check that needs it. Only a product that failed three checks in a row waits a day before AI tries it again, and the wait ends after a successful check. Store pacing, Retry-After, and bot-check pauses still apply: stores, not tokens, set the pace.

**Page size AI reads** sets how much of a product page AI reads when it reads a price: 200 KB of cleaned HTML by default, from 8 to 1,000 KB. The price, offer, and stock elements come first, followed by the rest of the page without scripts, styles, comments, or most attributes. Models with a large context window handle 200–500 KB; a small local model needs about 8–16 KB. When AI works a page step by step to resolve a check error, each step reads at most 64 KB.

**AI activity** shows what AI did in the last 24 hours: how many requests it made for each task, how many failed, how long they usually took, how many tokens they used, the latest error, and today's requests and tokens against the Limited budget. The journal behind it keeps no page content, answers, or keys, and keeps 30 days.

Six features use it:

- **Read prices the page parsers miss** sends the cleaned product page, up to **Page size AI reads**, within the **AI usage** limits. It also runs when the parsers found a price without a currency or with an unusable amount. A price the model returns is used only if it appears on the page as written.
- **Resolve check errors** steps in when a check cannot read a price (no price, no currency, an unusable amount, or a slow page). AI works the product page in the monitoring browser, one step at a time and at most six steps: it can wait for content, scroll, accept or reject a cookie banner, confirm an age prompt, close a pop-up, pick a variant or region, open the store's own canonical, AMP, or Shopify product data, and read the price. With **The model reads images** on, it can also read a price from a screenshot of the page. A price read by AI must appear on the page as written (or, from a screenshot, be read with very high confidence) and then passes the usual checks. Steps that let the page parsers find the price are remembered for the store and replayed first on later checks, without AI; a remembered recipe that stops working is forgotten. After an HTTP error, a timeout, a network error, or a redirect, AI also chooses how to recover within fixed limits: reset the store's saved cookies after a block, load the store in the browser instead of plain HTTP for 7 days, wait longer before checking the product again, or pause a product whose page is gone after repeated failures. The steps it took and its explanation appear in the check history. Price reading and resolving share the per-product wait of **AI usage**. It never buys, signs in, fills forms, leaves the store's site, or solves a bot check, and never retries a blocked store sooner than the normal backoff.
- **Confirm price changes** checks a price change against the product page before it notifies you, and also checks a price that jumped far more than usual (below half or above three times the recent price) even when that change would not notify. AI gets the cleaned page (up to **Page size AI reads**), the old and new price, the knife's brand, name, and key specs (such as blade length, steel, and model number), and the store's host name; never the regular price or notes. It answers whether the new price is the current price of exactly this product: the same variant and currency, for one item, and not a bundle, an accessory, a per-unit price, or a crossed-out price. When AI rejects the price with high confidence, the reading is kept in the history as unconfirmed, nothing notifies, the store keeps its last price, and the reason appears in the check history. A repeat of that price is checked again on later checks, and the old price coming back is not reported as a change. When AI is unavailable, unsure, or the daily budget is used up, changes notify as before. A price AI quotes in its reason must appear on the page as written; AI never sets a price. Confirming a change does not wait for the per-product wait of **AI usage**, but counts toward the daily caps.
- **Spot-check page readings** works with **AI usage** set to **Unlimited**. AI also checks the page parsers' readings: every reading on a product's first check, and every reading where the price changed. When AI is sure a reading is wrong, the store page is marked **AI doubts the price** under **Needs attention**, with AI's reason. The parser's price is kept, and the mark stays, with the page checked again on every check, until AI confirms the price, the price changes, or spot checks are turned off.
- **Daily summary in the Inbox** (in **Settings → Notifications → Price drops & stock**) has AI write a short summary once a day, from 6:00 on, server time: the best current prices against regular prices, the last 24 hours' drops and restocks, store pages that need attention, and what AI did (prices it read, checks it worked through, readings it doubted). It appears in the Inbox under **System**, and each day's summary replaces the previous one, which moves to **Done**. Only knife names, store names, and prices are sent: no notes, photos, links, or keys. A summary that quotes a price not in that data is discarded. Nothing is written on a day without news, and a failed attempt is retried an hour later (the next day when the daily budget is used up).
- **Pacing advisor** reviews each store's check statistics once a day, or after a store blocked checks twice, and may slow a store down, pause it, or set quiet hours within fixed limits. Only store host names and statistics are sent. AI can never speed a store up or shorten a pause after a bot check, and its advice lasts 48 hours. **Review pacing now** runs a review on demand.

The API key is stored next to the vault in its private control folder, outside backups, and the settings page only shows its last four characters. Docker and Helm can provide it with `BLADEVAULT_PRICE_AI_API_KEY` instead.

## Let AI supervise monitoring

**Settings → Price monitoring → AI assistance → AI supervisor** lets AI look over all of price monitoring and decide what needs attention. It needs [AI assistance](#optional-ai-assistance) connected.

| Mode        | What it does                                                         |
| ----------- | -------------------------------------------------------------------- |
| **Off**     | The default. AI does not supervise.                                  |
| **Observe** | AI plans what it would do and records it, without changing anything. |
| **Act**     | AI does what it planned, within fixed limits.                        |

The supervisor runs when something changes: a price drop or increase, a product selling out or coming back in stock, a product failing 3 or 5 checks in a row, a store showing a bot check, or **Other stores** finding a listing. It waits 2 minutes after the first change so a burst of changes is handled in one run, and runs at most every 10 minutes with **Unlimited** AI usage or every hour with **Limited**. Without changes it still looks over everything every hour with **Unlimited** and every 6 hours with **Limited**. **Run now** starts a run at once. Each run, AI sees:

- what changed since its last run, and why it runs now;

- every knife's market: its regular price, your target price, the best in-stock price now and its store, the lowest price ever and the lowest and highest of the last 90 days, the last price and stock change, and its **Other stores** searches;
- every monitored product under its knife: store, price, stock, how long it has been out of stock, status, when it was last checked and how it failed, and how many checks wait before it at its store;
- each store's pace and pauses, how many products are fresh, the AI budget, and the local date and time, so it can plan around sales;
- its last three runs, with why an action was refused or what the next check or search found;
- which knives it is watching closely, how often, and for how long;
- its notes and questions of the last weeks: read or not, and how you answered;
- the notes it keeps for itself (see **Remember** below).

It never sees product links, notes, or keys. It can:

- **Check first**: move up to 25 products to the front of their store's line, for example a knife near its target price ahead of others, or a product it wants read before it is due. A product that is already next at its store, or that was checked in the last 30 minutes, is left alone. A product blocked by a bot check still waits out its backoff.
- **Retry with AI**: let AI read or work the page of up to 10 failing products on their next check.
- **Change how a page loads**: switch up to 5 products to the browser, plain HTTP, or back to automatic.
- **Pause**: stop up to 3 products whose page failed at least 5 checks in a row and seems gone (not found or a redirect; never timeouts, server errors, or bot checks). Pages not found with HTTP 404 or 410 pause on their own after three checks. Resume them in the knife's **Price monitoring** section.
- **Look on other stores**: bring a waiting search forward for up to 5 knives, when [Other stores](#find-knives-at-other-stores-with-ai) is on. A knife that was never searched at a store is due anyway, and a listing already found stays.
- **Watch closely**: check up to 5 knives more often for a while, for example a knife near its target, a fresh drop that may go lower, or a restock to catch. A watch checks a knife's products at least every hour and at most for 72 hours, and only when that is more often than your schedule; up to 20 knives are watched at once. The knife's **Manage sources** shows the watch and its reason, with **Stop** to end it early. Each store's pace still applies.
- **Cross-check**: read all other stores of up to 5 knives now, for example after a price moved at one store, so you see the whole market. Products checked in the last 30 minutes, already queued, or blocked by a bot check are left out.
- **Advice**: leave a short note in the Inbox when something is worth acting on: a deal (a price at or below your target or regular price, a new 90-day low), a restock, or a trend to watch. Up to 6 notes a day, never for a muted knife, and not again for the same knife and topic within 3 days. A note that quotes a price AI was not shown is refused. **Open market** opens the knife's **Market** tab.
- **Questions**: ask you a yes/no question in the Inbox when your answer changes what it does: whether to set a target price it suggests, whether to watch a knife closely, or whether a listing **Other stores** found is the right knife. At most 3 questions wait at once, one per knife, and the same question is not asked again for 30 days. Your answer acts like the knife's own controls: the target price is set, the watch starts, or **Pause listing** pauses that listing (resume it in **Manage sources**). Questions you don't answer close after a week, and the supervisor sees every answer.
- **Remember**: keep up to 30 short notes for its later runs, about one knife or in general, for at most 30 days: what it is waiting for, a pattern it noticed (a store that restocks on Mondays), or what your answers told it. It forgets notes that are done. A note that quotes a price AI was not shown is refused. The **Supervisor** tab lists the notes under **Notes for later runs**, and **Forget** removes one.

Notes and questions appear only in **Act**, in the Inbox under **System**. Every action is checked before it runs, and actions that break the rules are refused and recorded with the reason. The supervisor can change the order of checks but not their pace: each store is still checked one product at a time, and store pauses, Retry-After, and bot-check pauses still apply. It never solves a bot check. The latest run and its summary appear under **AI supervisor** on **Price Drops**; while the supervisor is off and has never run, that strip is a single line with **Turn on**, which starts it in **Observe**. Runs are kept for 30 days.

## Find knives at other stores with AI

A knife's own store is often sold out. **Settings → Price monitoring → Other stores** lets AI look for every monitored knife at other stores and add the listings it finds as price sources. The list has Blade HQ (on by default), SMKW (Smoky Mountain Knife Works), DLT Trading, KnifeJoy and Northwest Knives (all off until you turn them on); Amazon is not searched. KnifeJoy and Northwest Knives are Shopify stores: BladeVault reads their search and product data directly, without opening the page in a browser, and searches each of them at most once every 15 minutes. Each store has its own switch, and more stores can be added later. It needs [AI assistance](#optional-ai-assistance) connected: with **Use AI** off, or without a base URL and model, nothing is searched.

1. Connect AI in **AI assistance**.
2. Turn on **Look for knives at other stores**.
3. Turn on the stores to search: **Blade HQ**, **SMKW**, **DLT Trading**, **KnifeJoy**, **Northwest Knives**, or any mix of them.

For each knife, AI does the work in three steps:

- **Find** — BladeVault opens the store's search for the knife's brand, name, and model number, and AI picks the listing that sells exactly this knife. Sheaths, sharpeners, parts, and other models never count.
- **Check** — BladeVault opens that product page, and AI confirms it is the same knife. A different steel, blade length, or lock is a different knife.
- **Parse** — the product becomes a source marked **Found by AI** and is checked like any other source. The page parsers read the price, and AI reads it or resolves the check when the parser cannot (with **Read prices the page parsers miss** and **Resolve check errors** on).

Searches cover every knife that price monitoring covers, including knives without a product link, and skip knives that already have a source at that store. They run with scheduled checks, one knife at a time, and share the store's pace: a due price check there always goes first, and a bot check pauses both. AI receives the knife's brand, name, and specs and the store's listing titles, never the regular price, notes, or photos.

The section lists recent results. A knife that is not found is searched again after 30 days, and a failed search after a few hours. **Search again for missing** searches those knives at the next free slot. A found listing is never replaced: remove its source to stop monitoring it, and it is not added again.

## Keep checking with the desktop app closed

In the desktop app, **Settings → Price monitoring → Desktop app → Keep running in the background** keeps BladeVault in the menu bar or system tray when you close its window, so scheduled checks continue. The tray menu offers **Open BladeVault**, **Check prices now**, and **Quit**. Use **Quit** to stop BladeVault completely.

When BladeVault starts again after being closed, overdue products are checked at the normal pace, not all at once.

**Desktop notifications for price drops** (off by default, in **Settings → Notifications → System notifications**) also shows price drops and restocks as system notifications while the BladeVault window is hidden, minimized, or closed to the tray. Only changes that reach the Inbox notify, after the window went away; several at once arrive as one summary. Clicking a notification opens the knife's Market tab, or the Inbox for a summary. Nothing is shown while App Lock is locked.

## Use price data from an AI client

BladeVault's [MCP tools](../reference/mcp.md#price-monitoring-tools) let an AI client such as Claude Desktop or Codex read monitored knives, recent drops and restocks, price history, and pages that need attention. With write access turned on in **Settings → AI / MCP**, the client can also change a knife's monitoring mode, add, pause, resume, or remove store URLs after a preview, and ask for **Check now**. Checks it requests wait for each store's normal pace, like the ones you start yourself.

## Related

- [Model Context Protocol (MCP)](../reference/mcp.md) — connect an AI client and review what it can change.
- [Your data](../reference/data.md) — where price history is stored and what backups include.
- [Docker and Podman](../installation/docker.md) and [Kubernetes with Helm](../installation/helm.md) — time zone and price monitoring settings for servers.
- [Desktop app](../installation/desktop.md) — the tray and background mode.
