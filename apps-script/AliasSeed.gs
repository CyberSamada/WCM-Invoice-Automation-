/**
 * AliasSeed.gs
 * Address -> project aliases: the SHIPPED DEFAULTS (mirrors project_aliases_seed.csv). These are
 * copied into the "Project Aliases" sheet tab exactly once by SheetService.gs/ensureKnowledgeSeeded_
 * (no manual import), after which that tab is the single editable home — coordinators add/remove
 * aliases from the dashboard's "Manage hints" panel or the learn-while-fixing field, NOT here. Edit
 * this list only to change the defaults a brand-new install starts with (and it won't override a
 * live tab that's already been seeded — a delete in the tab sticks).
 *
 * Each entry is [alias, project number, subproject number]. Subproject '' means "the whole project"
 * (let the extractor/reviewer pick the subproject).
 */
const SEED_ALIASES = [
  ['1175 Hyde Park Rd, London', '02', ''],
  ['952 Southdale Rd, London', '06', ''],
  ['15 Capulet Walk, London', '12', ''],
  ['332 Wellington Rd, London', '45', ''],
  ['352 Wellington Rd, London', '45', ''],
  ['2700 Tecumseh Rd W, Windsor', '46', ''],
  ['1310 Huron Church Rd, Windsor', '46+', ''],
  ['1340 Huron Church Rd, Windsor', '46+', ''],
  ['1370 Huron Church Rd, Windsor', '46+', ''],
  ['1475 Huron Church Rd, Windsor', '46++', ''],
  ['1600 Huron Church Rd, Windsor', '46+++', ''],
  ['315 Main St, Lucan', '47', ''],
  ['375 Daniel St S, Arnprior', '48', ''],
  ['1110 Goderich St, Port Elgin', '49', ''],
  ['1105 Wellington Rd, London', '54', ''],
  ['237 Clarke Rd E, Ingersoll', '55', ''],
  ['205 Renaud Line Rd, Belle River', '56', ''],
  // Hyland Centre unit 2D: the tenant fit-out is 43.14 ("2F (2D - MAC)"), which WCM tells vendors to
  // print as "Hyland Centre - Unit 2D - MAC". Kept tenant-specific on purpose — "2D" alone is also
  // 43.7 ("2F (2D - TBC)"), and "MAC" alone is also 43.10 ("RHC - MAC Unit (Dollarama)").
  // NOT seeded: the bill-to address (Unit 3B, 1701 Richmond St). That is WCM's own office and
  // already listed in CONFIG.OWN_BILLING_IDENTIFIERS as a thing to IGNORE when matching a project.
  ['Hyland Centre - Unit 2D - MAC', '43', '43.14'],
  ['Unit 2D - MAC', '43', '43.14']
];
