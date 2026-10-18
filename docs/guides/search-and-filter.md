# Search, filter, and sort your collection

Use search and filters to find knives by model name, specifications, custom fields, or measurements. Open **Collection** from the sidebar to work with the full list.

## Search by model name

1. Open **Collection** and choose **All knives**.
2. Type part of a model name into **Search model name…**. You can press `/` while outside a text field to focus it.
3. Review the matching cards. Search ignores letter case and matches any part of the model name.
4. Click a card to preview the knife, then choose **Open full page →** if you need its complete record.

Collection search checks the model name. To find a brand, model number, material, or other saved field, use **Filters**.

## Combine filters

1. Click **Filters** above the cards.
2. Open a field such as **Brand**, **Blade Material**, **Model Number**, or **Handle Material**.
3. Select one or more saved values. Use the search box inside a field's menu to find an option in a long list.
4. Choose values in another field to narrow the results further. Any custom fields you have defined appear here too.
5. Review the active filters shown below the controls.

Within one field, a knife can match any selected value. Across different fields, it must match every field. For example, selecting two blade materials and one handle material finds either steel with that handle material.

**Not set** appears when at least one record has no value for that field. Select it to find those records. Filter menus list values already saved in the vault; they do not create new values.

## Use measurement ranges

1. Open **Filters** and find **Measurement ranges**.
2. Enter an **At least** value, an **Under** value, or both for a measurement.
3. Use millimeters for lengths and blade thickness, and grams for weight, as shown beside each field.
4. Check the matching cards before adding more ranges.

**At least** includes the boundary; **Under** excludes it. For example, blade length `70` to `90` includes 70 mm and excludes 90 mm. Values must be non-negative, and a lower bound must be smaller than its upper bound.

BladeVault reads the units in saved measurements when comparing them with these ranges. A record with a missing or unreadable measurement does not match an active range for that measurement. Use [data quality review](improve-data-quality.md) to check values that need attention.

## Find missing specifications

1. Open **Filters**.
2. Select **Any missing specification** below the measurement ranges.
3. Review the matching records, or combine this option with a brand or other filter.

This finds records missing one or more of the built-in specification fields used by collection filters, excluding Brand. It does not check notes, images, or custom fields. To find a missing value in a particular field, use that field's **Not set** option.

## Sort and clear results

Use the sort menu above the cards to choose **Newest added**, **Model A–Z**, or **Brand A–Z**. If **Keep pinned knives first** is enabled in Settings, pinned knives appear before other results, with the chosen sort applied within those groups.

Click the × beside an active filter to remove it. A field menu's **Clear** button removes all selected values for that field. **Clear all** removes the search and filters together and leaves the current collection tab selected.

To reuse a search and filters later, click **Save smart collection**. See [Create and manage Smart Collections](smart-collections.md).

## Find a model number with global search

1. Open **Insights**, a knife record, or another page that shows **Find a knife** at the top.
2. Click **Find a knife**, or press `/` while outside a text field.
3. Type a model name, or enter `/model A4301` to search only model numbers. Replace `A4301` with all or part of the number you need.
4. Select a result to open its record.

Global search and the inline search on the **Compare** page support `/model`. The collection's own search box uses model names; choose its **Model Number** filter to find a saved number there. The separate **Add knives** dialog on Compare searches names, brands, model numbers, and blade materials as plain text. See [Compare knives](compare.md).

## Related guides

- [Create and manage Smart Collections](smart-collections.md) — save useful searches and filters.
- [Edit and pin several knives at once](bulk-actions.md) — apply an action to selected matches.
- [Customize cards and collection appearance](customize-appearance.md) — choose visible details and pinned ordering.
