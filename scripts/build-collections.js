#!/usr/bin/env node
/**
 * build-collections.js
 *
 * Keeps the duplicated blocks across collections/*.postman_collection.json
 * in sync with the canonical copies in shared-scripts/.
 *
 * Why this exists: Postman collection-level scripts (the AES encryption/
 * decryption logic) and folder structures (the existing-user login block,
 * the accounts-retrieve-all block) can't be shared across separate
 * collection files at runtime — each .postman_collection.json has to carry
 * its own full copy of anything it needs. This script is the single place
 * those copies get generated from, so a fix only has to be made once, in
 * shared-scripts/, instead of by hand in every collection file.
 *
 * Usage:
 *   node scripts/build-collections.js          # writes updated collections
 *   node scripts/build-collections.js --check  # dry run — exits 1 if any
 *                                                 collection is out of sync,
 *                                                 without writing anything.
 *                                                 Use this in CI / a
 *                                                 pre-commit hook.
 *
 * IMPORTANT: if you need to change the decryption script, the login flow,
 * or the accounts-retrieve-all logic, edit the corresponding file under
 * shared-scripts/ — NOT the copy inside a collection file, and NOT via the
 * Postman GUI directly. A GUI edit to one of these managed blocks will be
 * silently overwritten next time this script runs. See docs/README.md,
 * "Keeping shared scripts in sync", for the full workflow.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COLLECTIONS_DIR = path.join(ROOT, 'collections');
const MANIFEST_PATH = path.join(__dirname, 'build-manifest.json');

const CHECK_ONLY = process.argv.includes('--check');

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function collectionPath(name) {
  return path.join(COLLECTIONS_DIR, `${name}.postman_collection.json`);
}

/**
 * Recursively walk a Postman item tree and replace every folder whose
 * "name" matches folderName with a deep copy of replacement. Returns the
 * number of replacements made (0 means the folder name wasn't found at
 * all in this collection — worth a warning, since every configured target
 * is expected to match at least once).
 */
function replaceNamedFolders(items, folderName, replacement) {
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.name === folderName && Array.isArray(it.item)) {
      items[i] = JSON.parse(JSON.stringify(replacement));
      count++;
      // Deliberately do NOT recurse into a folder we just replaced —
      // the replacement is the canonical content, nothing inside it
      // should be walked again.
      continue;
    }
    if (Array.isArray(it.item)) {
      count += replaceNamedFolders(it.item, folderName, replacement);
    }
  }
  return count;
}

function applyCollectionEventTarget(target) {
  const source = loadJson(path.join(ROOT, target.source));
  const results = [];

  for (const name of target.collections) {
    const filePath = collectionPath(name);
    const collection = loadJson(filePath);

    const before = JSON.stringify(collection.event || []);
    collection.event = JSON.parse(JSON.stringify(source));
    const after = JSON.stringify(collection.event);

    results.push({
      file: path.relative(ROOT, filePath),
      changed: before !== after,
      collection,
      filePath
    });
  }

  return results;
}

function applyNamedFolderTarget(target) {
  const source = loadJson(path.join(ROOT, target.source));
  const results = [];

  for (const name of target.collections) {
    const filePath = collectionPath(name);
    const collection = loadJson(filePath);

    const before = JSON.stringify(collection.item);
    const matchCount = replaceNamedFolders(collection.item, target.folderName, source);
    const after = JSON.stringify(collection.item);

    if (matchCount === 0) {
      console.warn(
        `  WARNING: folder "${target.folderName}" not found anywhere in ` +
        `${path.relative(ROOT, filePath)} — target "${target.description}" ` +
        `matched nothing in this file.`
      );
    }

    results.push({
      file: path.relative(ROOT, filePath),
      changed: before !== after,
      matchCount,
      collection,
      filePath
    });
  }

  return results;
}

function main() {
  const manifest = loadJson(MANIFEST_PATH);
  const allResults = [];

  for (const target of manifest.targets) {
    console.log(`\n${target.type}: ${target.description}`);

    let results;
    if (target.type === 'collection-event') {
      results = applyCollectionEventTarget(target);
    } else if (target.type === 'named-folder') {
      results = applyNamedFolderTarget(target);
    } else {
      throw new Error(`Unknown target type in manifest: ${target.type}`);
    }

    for (const r of results) {
      const extra = 'matchCount' in r ? ` (${r.matchCount} occurrence${r.matchCount === 1 ? '' : 's'})` : '';
      if (r.changed) {
        console.log(`  UPDATE  ${r.file}${extra}`);
      } else {
        console.log(`  OK      ${r.file}${extra}`);
      }
    }

    allResults.push(...results);
  }

  const changedResults = allResults.filter(r => r.changed);

  if (CHECK_ONLY) {
    if (changedResults.length > 0) {
      console.log(
        `\n${changedResults.length} collection file(s) are out of sync ` +
        `with shared-scripts/. Run "npm run build" to fix, then commit ` +
        `the result.`
      );
      process.exit(1);
    }
    console.log('\nAll collections are in sync with shared-scripts/.');
    process.exit(0);
  }

  // Write mode: only touch files that actually changed, to keep diffs clean.
  const changedFiles = new Set();
  for (const r of allResults) {
    if (r.changed) {
      writeJson(r.filePath, r.collection);
      changedFiles.add(r.file);
    }
  }

  if (changedFiles.size === 0) {
    console.log('\nNothing to update — all collections already in sync.');
  } else {
    console.log(`\nUpdated ${changedFiles.size} file(s):`);
    for (const f of changedFiles) console.log(`  - ${f}`);
  }
}

main();
