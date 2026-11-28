---
paths:
  - 'lib/scrape*.ts'
  - 'app/api/scrape/**'
  - 'tests/unit/scrape-*.test.ts'
  - 'tests/fixtures/scrape/**'
---

# Scraper and import

- Before changing a rule, inspect the real product and variant markup and the existing extractor. Look at structured data, lazy-loaded attributes and original gallery URLs.
- Scope extraction away from related-product blocks. Leave unsupported or contradictory values empty, and make sure later enrichment or fallbacks can't bring a rejected value back.
- Meaningful extraction changes get a source fixture in `tests/fixtures/scrape/` and a focused `tests/unit/scrape-*.test.ts` regression.
- Test extraction separately from how the Add/Edit form applies it and from saved state. Preserve manual field edits and image selections.
