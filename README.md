# Le Portée Hotel Upgrade Finder

planner.leportee.com: what a hotel should add next, from Booking.com listings and what
actually moves their review scores. Static site (GitHub Pages), no dependencies, no trackers;
the only third-party request is the Substack subscribe form, loaded when someone clicks
"Subscribe".

- `index.html` · `app.js` — the page and its arithmetic (mirrors the research dashboard's
  /planner page in `mishka-research`)
- `data/<cc>.model.json` · `data/<cc>.json` — one pair per country (de fr es it at), each its
  own study, written by `mishka-research/analysis/planner_export.py`; never edit by hand
- `og.png` — the link preview

## Refresh the data

```bash
cd ~/mishka-research
for cc in de fr es it at; do
    lake=data/countries/$cc/lake; [ $cc = de ] && lake=data/lake
    LAKE_DIR=$PWD/$lake .venv/bin/python3 analysis/planner_export.py --out ~/leportee-planner/data --country $cc
done
cd ~/leportee-planner && git add -A && git commit -m "data: refresh" && git push
```

## The subscriber code

The full plan unlocks with a code sent in the Le Portée welcome email (Substack → Settings →
Emails → Welcome email). `app.js` holds only its SHA-256 hash (`UNLOCK_HASH`), computed on the
lower-cased code. To change the code:

```bash
printf '%s' "new-code" | sha256sum      # lower-case first; paste into UNLOCK_HASH
```

Then update the welcome email. Readers who unlocked before keep access (stored in their
browser).

## What is public, by decision (17 Oct 2026)

Per hotel only: name, town, rounded location, archetype, review score, sub-scores, review count
and the facilities it lists. No prices, operators, URLs or Booking ids. Properties with fewer
than 20 reviews are left out. A takedown request means removing the row in the exporter and
refreshing.
