# WCM / Westdell Property Address List

The canonical street address(es) for each property, used to **strengthen the Project Aliases**
lookup: invoices often print a job-site or ship-to *address* instead of the property's name, and an
address the automation doesn't recognize can't be matched. Loading these addresses as aliases (see
`project_aliases_seed.csv` and the **Project Aliases** tab) lets an invoice that mentions only the
address file to the right project.

> **Note:** This file and `project_aliases_seed.csv` are human-readable **mirrors** of the shipped
> defaults in `apps-script/AliasSeed.gs`. The live, editable home is the **Project Aliases** sheet
> tab — coordinators add/remove aliases there via the dashboard's **Manage hints** panel (or the
> "what identifies this project?" box when fixing an invoice), no code change needed. Keep these
> mirrors roughly in step with the defaults, but the tab is the source of truth at runtime.

**Source legend**
- `name` — the address is already embedded in the project name in `project_reference.csv` (so Gemini
  already sees it; no alias strictly needed).
- `records` — from another file in this repo (`site_coordinators_PRIVATE.md`).
- `owner` — confirmed directly by WCM/Westdell staff.
- `web` — researched from public listings; treated as good but not owner-confirmed.

| Proj # | Property | Address(es) | Source |
|--------|----------|-------------|--------|
| 02 | Hyde Park Square | 1175 Hyde Park Rd, London, ON N6H 5K6 | owner |
| 05 | Oxford Westdell Centre | 1919 & 1929 Oxford St, London | name |
| 06 | Forest Edge Commons | 952 Southdale Rd, London *(sub 6.3: 2580 Colonel Talbot Rd)* | name / records |
| 08 | 875 Wellington | 875 Wellington Rd, London | name |
| 10 | Rose City SC | 5050 Tecumseh Rd E, Windsor | name |
| 12 | Sereno | 15 Capulet Walk, London | name |
| 21 | Aria North | 420 Fanshawe Park Rd E, London | name |
| 43 | Hyland Centre | 1701–1737 Richmond St, London *(also the WCM/Westdell office)* | name |
| 45 | Wellington Gate | 332–352 Wellington Rd, London | owner / web |
| 46 | University Plaza | 2700 Tecumseh Rd W, Windsor | owner |
| 46+ | Gateway Village | 1310, 1340, 1370 Huron Church Rd, Windsor | owner |
| 46++ | West Gate SC | 1475 Huron Church Rd, Windsor | records |
| 46+++ | Ambassador Plaza | 1600 Huron Church Rd, Windsor *(current unit; may expand)* | owner |
| 47 | The Glenns SC | 315 Main St, Lucan | web |
| 48 | Arnprior Shopping Centre | 375 Daniel St S, Arnprior | web |
| 49 | Saugeen Shores SC | 1110 Goderich St, Port Elgin | web |
| 52 | Arnprior Gate | 245 Daniel St, Arnprior | name |
| 53 | Stoney Creek Commons | 1300 Fanshawe Park Rd E, London | name |
| 54 | White Oaks Mall | 1105 Wellington Rd, London | owner |
| 55 | Clarke Commercial SC | 237 Clarke Rd E, Ingersoll | web |
| 56 | Lakeshore Town Centre | 205 Renaud Line Rd, Belle River | owner |
| 57 | Noor Gardens | 457 Southdale Rd, London | name |
| 58 | Oxbury Mall | 1299 Oxford St, London | name |
| 59 | Elgin Commercial Centre | 1025 Elgin St, Cobourg | name |
| 60 | Wyandotte Commercial Centre | 3975 Wyandotte St E, Windsor | name |

## Disambiguation — real misfile traps

- **Windsor "Huron Church" cluster.** Four separate properties sit within a block of each other on
  Huron Church Rd, plus one on the cross street. Match by the exact street number:
  - 46 University Plaza → **2700 Tecumseh Rd W** (the cross street, at Huron Church & Tecumseh)
  - 46+ Gateway Village → **1310 / 1340 / 1370 Huron Church Rd**
  - 46++ West Gate SC → **1475 Huron Church Rd**
  - 46+++ Ambassador Plaza → **1600 Huron Church Rd**
- **Arnprior, same street.** 48 Arnprior Shopping Centre = **375 Daniel St S**; 52 Arnprior Gate =
  **245 Daniel St**. Both on Daniel St — the number decides.
- **Hyde Park Square ≠ Hyde Park Plaza.** Project 02 is Westdell's **Hyde Park Square, 1175 Hyde Park
  Rd**. "Hyde Park Plaza" at 1180 Oxford St W is a *different company's* property — never map it to 02.

## Aliases seeded from this list

Properties whose address is **not already in the project name** are seeded as aliases. A few
name-embedded ones are also seeded because the matcher was still getting them wrong in practice, and
an explicit alias is a stronger, more direct signal than the reference name:

- **06 Forest Edge Commons — 952 Southdale Rd** (invoices for 952 Southdale were misfiling)
- **12 Sereno — 15 Capulet Walk** (the name abbreviates "Walk" to "WK")

These aliases live in code (`apps-script/AliasSeed.gs`) and are merged in automatically by
`getAliasData_` — **no manual import needed**; they're active on the next deploy. `project_aliases_seed.csv`
is kept as a human-readable mirror. To add/change an alias, edit `AliasSeed.gs` (a row hand-added to the
"Project Aliases" tab still wins over a code seed on the same alias + project).
