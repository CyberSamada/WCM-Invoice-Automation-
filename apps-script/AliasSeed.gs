/**
 * AliasSeed.gs
 * Address -> project aliases maintained in code (mirrors project_aliases_seed.csv). These are merged
 * into whatever's in the "Project Aliases" tab by SheetService.gs/getAliasData_, so they take effect
 * on deploy with NO manual import. A row hand-added to the tab wins over a code seed with the same
 * alias + project number.
 *
 * Each entry is [alias, project number, subproject number]. Subproject '' means "the whole project"
 * (let the extractor/reviewer pick the subproject). To add or change an alias, edit this list.
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
  ['205 Renaud Line Rd, Belle River', '56', '']
];
