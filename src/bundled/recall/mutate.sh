#!/usr/bin/env bash
# Removes each safety guard in turn and expects the suite to fail. A mutant that leaves the source unchanged is
# a broken mutation, not a pass, so the script refuses it; the unmutated suite must pass first.
#
#   src/bundled/recall/mutate.sh            every mutation, one line each, exit 1 if any survives
#
# Each row: name | file | perl substitution that removes the guard. Add a row with each new guard.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
check_only=${1:-}
if [[ -n "$check_only" && "$check_only" != "--check" ]]; then echo "usage: $0 [--check]" >&2; exit 2; fi

MUTANTS=$(cat <<'ROWS'
I-DATA escape < | src/bundled/recall/pack.ts | s{\.replace\(/</g,\s*"&lt;"\)}{}
I-DATA escape > | src/bundled/recall/pack.ts | s{\.replace\(/>/g,\s*"&gt;"\)}{}
I-DATA escape & | src/bundled/recall/pack.ts | s{\.replace\(/&/g,\s*"&amp;"\)}{}
I-DATA escape & order | src/bundled/recall/pack.ts | s{(\.replace\(/&/g,\s*"&amp;"\))(\s*)(\.replace\(/</g,\s*"&lt;"\)\s*\.replace\(/>/g,\s*"&gt;"\))}{$3$2$1}s
I-DATA one line | src/bundled/recall/pack.ts | s{\.replace\(BREAKS,\s*"\s*"\)}{}
I-DATA bidi | src/bundled/recall/pack.ts | s{\.replace\(BIDI,\s*""\)}{}
I-DATA metadata escaped | src/bundled/recall/pack.ts | s{escape\(\(c\.author}{(\(c.author}
I-DATA memory slug escaped | src/bundled/recall/pack.ts | s{escape\(c\.id\.replace}{(c.id.replace}
I-DATA link encoded | src/bundled/recall/pack.ts | s{encodeURIComponent\(c\.id\)}{c.id}
budget | src/bundled/recall/pack.ts | s{if\s*\(used\s*\+\s*size\s*>\s*BUDGET\)\s*continue;}{}
whole excerpts | src/bundled/recall/pack.ts | s{if\s*\(used\s*\+\s*size\s*>\s*BUDGET\)\s*continue;}{if (used + size > BUDGET) break;}
empty is nothing | src/bundled/recall/pack.ts | s{return\s*any\s*\?\s*block\s*:\s*"";}{return block;}
I-DATA own fields only | src/bundled/recall/pack.ts | s#const\s*text\s*=\s*escape\(c\.text\);#const text = escape(c.text + JSON.stringify(c));#
I-FLOW same channel only when S = T | src/bundled/recall/find.ts | s{if\s*\(s\s*===\s*t\)\s*return\s*true;}{}
I-FLOW unknown target | src/bundled/recall/find.ts | s{!known\(source\)\s*\|\|\s*!known\(target\)}{!known(source)}
I-FLOW incomplete listing | src/bundled/recall/find.ts | s{f\.visibility\s*===\s*"open"\s*\|\|\s*f\.complete}{true}
I-FLOW private never into open | src/bundled/recall/find.ts | s{if\s*\(target\.visibility\s*===\s*"open"\)\s*return\s*false;}{}
I-FLOW members subset | src/bundled/recall/find.ts | s{return\s*target\.members\.every\(\(m\)\s*=>\s*readers\.has\(m\)\);}{return true;}
I-MEM open is not owner-only | src/bundled/recall/find.ts | s{facts\.visibility\s*===\s*"open"\s*\|\|\s*}{}
I-MEM complete listing | src/bundled/recall/find.ts | s{!facts\.complete\s*\|\|\s*}{}
I-MEM owner and agent only | src/bundled/recall/find.ts | s{m\s*===\s*owner\s*\|\|\s*m\s*===\s*agent}{true}
I-MEM opt-in only | src/bundled/recall/find.ts | s{settings\.sharedMemories\s*\|\|\s*}{}
I-FRESH tombstones | src/bundled/recall/find.ts | s{listing\.entries\.filter\(\s*\(m\)\s*=>\s*!\(m\.createdAt\s*<=\s*\(deleted\.get\(m\.slug\)\s*\?\?\s*-Infinity\)\),?\s*\)}{listing.entries}
I-ROUTE channel scope | src/bundled/recall/find.ts | s{\.\.\.\(scoped\s*\?\s*\{\s*"#h":\s*\[turn\.channel\]\s*\}\s*:\s*\{\}\),}{}
triggering event dropped | src/bundled/recall/find.ts | s{\.filter\(\(c\)\s*=>\s*c\.id\s*!==\s*turn\.event\)}{}
I-OPEN/CLOSED reads fail closed | src/bundled/recall/recall.ts | s#catch\s*\{\n\s*return\s*undefined;#catch (e) {\n    throw e;#
selector gated on readiness | src/bundled/recall/index.ts | s{status\s*===\s*"ready"\s*\|\|\s*status\s*===\s*"unconfirmed"}{true}
I-WRITE no persist | src/bundled/recall/settings.ts | s#\s*\s*try\s*\{#  try { localStorage.setItem(KEY, "{}");#
settings fall back narrow | src/bundled/recall/settings.ts | s#s\.sharedMemories\s*===\s*true#!!s.sharedMemories#
inactive card writes nothing | src/bundled/recall/card.tsx | s#if\s*\(!active\(\)\)\s*return;##
I-REST clear bumps generation | src/bundled/recall/embed.ts | s{generation\+\+;}{}
I-FRESH memory version rechecked | src/bundled/recall/embed.ts | s{currentMem.get\(stamp\(r\)\)}{currentMem.values().next().value}
I-FLOW cross-channel vector hit permission | src/bundled/recall/embed.ts | s{!mayFlow\(s,\s*turn.channel,\s*sources.get\(s\),\s*target\)}{false}
I-ROUTE relay vector banks | src/bundled/recall/embed.ts | s{settings\(\).scope\s*===\s*"relay"}{false}
I-MEM disallowed banks excluded before ranking | src/bundled/recall/embed.ts | s{\.\.\.\(allowMem\s*\?\s*\[memoryKey\]\s*:\s*\[\]\)}{...[memoryKey]}
I-FRESH superseded memory vectors pruned | src/bundled/recall/embed.ts | s{bank.delete\(id\);}{void id;}
I-FRESH newer snapshot wins | src/bundled/recall/embed.ts | s{if\s*\(s.sequence\s*<\s*\(latest.get\(s.key\)\s*\?\?\s*-1\)\)\s*return;}{}
settings merge latest preference | src/bundled/recall/card.tsx | s{const\s*next\s*=\s*\{\s*...load\(\),\s*...change\s*\};}{const next = { ...settings, ...change };}
I-REST queued message byte cap | src/bundled/recall/embed.ts | s{text: boundedInput\(e.content\)}{text: e.content}
I-REST queued memory byte cap | src/bundled/recall/embed.ts | s{text: boundedInput\(text.trim\(\)\)}{text: text.trim()}
semantic failure stays lexical | src/bundled/recall/find.ts | s{semantic.neighbours\(turn\).catch\(\(\)\s*=>\s*\[\]\)}{semantic.neighbours(turn)}
snapshot awaited before lease ends | src/bundled/recall/recall.ts | s{await Promise.race\(\[observing, expired\]\)}{undefined}
snapshot wait preserves deadline reserve | src/bundled/recall/recall.ts | s{await Promise.race\(\[observing, expired\]\)}{await observing}
I-FLOW exactly one channel | src/bundled/recall/find.ts | s{h.length === 1}{h.length >= 1}
endpoint credentials | src/bundled/recall/embed-client.ts | s{url.username \|\|\s*url.password \|\|}{}
endpoint protocol | src/bundled/recall/embed-client.ts | s{url.protocol === "https:"}{true}
endpoint hostname | src/bundled/recall/embed-client.ts | s{url.hostname === "\[::1\]"}{true}
vector dimensions | src/bundled/recall/embed-client.ts | s{value.length !== dimensions}{false}
vector finite | src/bundled/recall/embed-client.ts | s{Number.isFinite\(n\)}{true}
vector zero | src/bundled/recall/embed-client.ts | s{if \(!scale\) throw new Error\("Zero embedding"\);}{}
vector normalization | src/bundled/recall/embed-client.ts | s{n / scale / norm}{n}
response count | src/bundled/recall/embed-client.ts | s{data.data.length !== inputs.length}{false}
response index duplicates | src/bundled/recall/embed-client.ts | s{ordered\[row.index\]\n}{false\n}
response status | src/bundled/recall/embed-client.ts | s{response.status !== 200}{false}
returned model reset | src/bundled/recall/embed-client.ts | s{model !== undefined && model !== data.model}{false}
late endpoint response | src/bundled/recall/embed-client.ts | s{current !== epoch}{false}
final byte cap | src/bundled/recall/embed-client.ts | s{inputs.map\(boundedInput\)}{inputs}
client timeout | src/bundled/recall/embed-client.ts | s{, ms\);}{, ms + 1000);}
URL drops old key | src/bundled/recall/embed-card.tsx | s{if \(field === "embeddingUrl"\) next.embeddingKey = "";}{}
inactive endpoint card | src/bundled/recall/embed-card.tsx | s{if \(!active\(\)\) return false;}{}
late test result | src/bundled/recall/embed-card.tsx | s{current === revision.current}{true}g
query timeout | src/bundled/recall/embed.ts | s{Math.max\(1, Math.min\(1000, turn.deadline - now\(\)\)\)}{10000}
transport failure stops snapshot | src/bundled/recall/embed.ts | s{if \(!\(error instanceof EmbeddingHttpError\)\) throw error;}{}
HTTP status filter restored | src/bundled/recall/embed.ts | s{if \(!\(error instanceof EmbeddingHttpError\)\)}{if (!(error instanceof EmbeddingHttpError) || error.status !== 400)}
failed batch continues | src/bundled/recall/embed.ts | s{if \(!vectors\) continue;}{if (!vectors) break;}
running snapshot sequence | src/bundled/recall/embed.ts | s{s.sequence !== latest.get\(s.key\)}{false}g
embeddings stop on unload | src/bundled/recall/index.ts | s{ctx.effect\(\(\)\s*=>\s*\(\)\s*=>\s*semantic.disable\(\)\);}{}
ROWS
)

# Isolate edits and retain per-mutant logs; never mutate the source worktree.
artifacts=${RECALL_MUTATION_ARTIFACTS:-"${TMPDIR:-/tmp}/recall-mutations"}
mkdir -p "$artifacts"
work=$(mktemp -d "$artifacts/run.XXXXXX")
mkdir -p "$work/src/bundled"
cp -R src/bundled/recall "$work/src/bundled/recall"
cp tsconfig.json "$work/tsconfig.json"
ln -s "$root/node_modules" "$work/node_modules"
# The real HostService regression uses app runtime modules; mutations stay in Recall.
ln -s "$root/src/features" "$work/src/features"
suite() { (cd "$work" && "$root/bin/node" "$root/node_modules/vitest/vitest.mjs" run --config "$root/vitest.config.ts" --root "$work" src/bundled/recall --reporter=dot) >"$work/$1.log" 2>&1; }

if [[ "$check_only" != "--check" ]]; then
  suite baseline || { echo "unmutated suite fails; see $work/baseline.log"; exit 2; }
  echo "unmutated: pass"
fi

survived=0
number=0
while IFS='|' read -r name file sub; do
  name=$(echo "$name" | xargs); file=$(echo "$file" | xargs); sub=$(echo "$sub" | sed 's/^ *//')
  number=$((number + 1))
  cp "$file" "$work/$file"
  perl -0pi -e "$sub" "$work/$file"
  if cmp -s "$file" "$work/$file"; then
    echo "BROKEN   $name: substitution did not change $file"; survived=1; continue
  fi
  if [[ "$check_only" == "--check" ]]; then echo "changed  $name";
  elif suite "mutant-$number"; then echo "SURVIVED $name"; survived=1; else echo "killed   $name"; fi
  cp "$file" "$work/$file"
done <<< "$MUTANTS"

if [[ "$check_only" != "--check" ]]; then
  suite restored || { echo "restored suite fails; see $work/restored.log"; exit 2; }
  echo "restored: pass"
fi
echo "artifacts: $work"
exit $survived
