# Log maintenance and sharpening

[![Watch the Log Maintenance walkthrough on YouTube](https://img.youtube.com/vi/_Yrw6v5V1yc/hqdefault.jpg)](https://youtu.be/_Yrw6v5V1yc)

Maintenance records the care you perform on each knife, including when it happened and any useful details. Open a saved knife from **Collection**, choose **Open full page →** in its preview, then scroll to **Maintenance**.

## Log a quick entry for today

1. In **Maintenance**, select **Cleaned**, **Lubricated**, **Sharpened**, **Stropped**, or **Disassembled**.

   ![The quick actions in Maintenance, with Add maintenance beside them](../images/log-maintenance-quick-actions.png)

2. Wait for the entry to appear under **History**.

   ![The summary tiles above History, with the new entry listed for today](../images/log-maintenance-history.png)

The selected action saves an entry immediately with the current date and time and no notes. Each press creates an entry. Use **Add maintenance** when you want to choose a date or include details.

## Add a dated entry with notes

1. Select **Add maintenance**.

   ![The Add maintenance button beside the quick actions](../images/log-maintenance-add-button.png)

2. Set **Date** to the day the work took place.

   ![The Add maintenance dialog with its Date, Type, and Notes fields](../images/log-maintenance-add-dialog.png)

3. Choose **Type**. Alongside the quick actions, the form offers **Reassembled**, **Hardware replaced**, **Part replaced**, and **Other**.

   ![The Type menu listing every maintenance type](../images/log-maintenance-type-menu.png)

4. Describe the work or observations in **Notes**.
5. Select **Save**.

The entry appears in the knife's history under its chosen date. The summary shows the latest recorded cleaning, lubrication, sharpening, and disassembly dates; **Never** means no entry of that type has been recorded.

![A saved entry in History under its date, with its recorded details](../images/log-maintenance-entry-saved.png)

## Record sharpening or stropping details

1. Select **Add maintenance**, or edit an existing entry.
2. Choose **Sharpened** or **Stropped** as the type to reveal **Sharpening details**.

   ![The Sharpening details fields revealed by the Sharpened type](../images/log-maintenance-sharpening-details.png)

3. Fill in the details you want to keep:

| Field                | What to record                                                                  |
| -------------------- | ------------------------------------------------------------------------------- |
| **Grit**             | The abrasive grit or progression you used.                                      |
| **Angle**            | The sharpening angle, including any useful convention such as degrees per side. |
| **System**           | Your sharpening system or equipment.                                            |
| **Passes**           | A nonnegative whole-number count of passes.                                     |
| **Ceramic**          | The ceramic abrasive you used.                                                  |
| **Strop**            | The strop material or product.                                                  |
| **Compound**         | The stropping compound.                                                         |
| **Sharpening notes** | Extra observations about the edge or technique.                                 |

![A sharpening entry with its details filled in](../images/log-maintenance-sharpening-filled.png)

4. Add any general **Notes**, then select **Save** or **Save changes**.

These details are optional and appear with the entry in **History**. They describe that maintenance event; they do not replace the knife's specifications or create a maintenance schedule.

## Correct or delete an entry

1. Find the entry under **History**.
2. Select its pencil button, **Edit maintenance entry**.

   ![The Edit maintenance dialog for an existing entry](../images/log-maintenance-edit-dialog.png)

3. Correct the date, type, notes, or sharpening details and select **Save changes**.

To remove an entry, select its trash button, **Delete maintenance entry**, and confirm **Delete this maintenance entry?** The entry disappears from the knife's maintenance history. The latest-date summary updates to reflect the remaining entries.

![An entry's edit and delete buttons at the end of its row](../images/log-maintenance-entry-actions.png)

## Get care reminders

BladeVault reminds you when a knife is due for sharpening, cleaning, or lubrication. By default sharpening is due every 90 days, cleaning every 60, and lubrication every 180; a stropping entry counts as sharpening. Change these in **Settings → Maintenance**, or select **Customize…** under a knife's **Maintenance** to give that knife its own intervals.

Each kind of care counts from the last time you logged it. A kind of care you have never logged on a knife has no date to count from, so it gives no reminder until you log it once. A knife that is only ever sharpened is reminded about sharpening alone. Its status is one of:

| Status         | Meaning                                                                       |
| -------------- | ----------------------------------------------------------------------------- |
| **Overdue**    | A logged kind of care is past its interval.                                   |
| **Due soon**   | A logged kind of care is due within the due-soon window (14 days by default). |
| **Up to date** | Every logged kind of care is inside its interval.                             |

Turn on the **Care** card field to show a status badge on collection cards, or filter the collection by **Care**. **Insights** has a **Care status** card listing the knives that need attention.

### Use the Inbox

When a knife turns due soon or overdue, a message arrives in **Inbox**. The bell in the header, or the **Inbox** row in the Classic sidebar, shows how many messages are unread. Each message offers:

- **Log … today**: records that care for today, which resolves the message.
- **Snooze**: hides the message until tomorrow, or for 3 days, a week, or a month. It comes back unread.
- **Dismiss**: hides the message until that care is logged again. Find it under **Done** and select **Move back to inbox** to undo.

Logging the care any other way also resolves the message. A due-soon message that becomes overdue is marked unread again. Closed messages stay under **Done** for 90 days.

## Review care across the collection

Select the **Care status** card on **Insights** for the full care page:

- Overdue, due-soon and up-to-date counts, the next deadline, and how many entries you logged this month.
- A card for each kind of care with its interval, the most overdue knife, the next deadline, the last entry, and how often you usually do it. When you usually wait clearly longer than the interval, the card suggests changing it.
- **Coming up**: overdue jobs, then the deadlines in the next 30 days.
- Entries per month for the last six months, and the latest entries with their notes and sharpening angle.
- Lists of the knives that need attention and of every tracked knife.

Open **History** and select **Maintenance** to see maintenance activity for all knives. Expand an event to inspect its details. History also records edits and deletions, so it is useful when you need to understand a change to the history.

![The History page filtered to Maintenance activity](../images/log-maintenance-logs.png)

![An expanded maintenance event in History, with its changes](../images/log-maintenance-logs-event.png)

## Related

- [Review collection activity in History](review-collection-activity.md) — search and filter recorded events.
- [Update a saved knife](update-a-saved-knife.md) — edit the knife's specifications and other fields.
- [MCP](../reference/mcp.md) — read maintenance history or allow a connected client to add an entry.
- [Back up and restore your vault](back-up-and-restore-your-vault.md) — preserve maintenance history with your collection.
