#!/usr/bin/env python3
"""Verify the manuscript and corrected ablation against the frozen artifact.

Every empirical figure in the paper must be reproducible from
scratch/arena_corrected.json (run 2026-10-08 / net, n_cohort 47), which is
produced by scratch/arena_corrected.js on the frozen registry revision. This
checker reads that JSON, recomputes the values the tables quote, and asserts
each one appears in the manuscript -- and that the retracted figures do not.

Run: python scratch/verify_frozen_panels.py
"""
import io
import json
import json
import os
import re
import sys
from pathlib import Path

MAIN = 'paper.tex'
FROZEN = 'scratch/arena_corrected.json'
ABLATION = 'scratch/ablation_components.json'
SWING = 'scratch/weights_swing.json'

text = io.open(MAIN, encoding='utf-8').read()
coauthor_path = Path(__file__).resolve().parents[2] / 'docs' / 'co-author.tex'
coauthor_text = coauthor_path.read_text(encoding='utf-8') if coauthor_path.is_file() else None
j = json.load(io.open(FROZEN, encoding='utf-8'))
run = next(r for r in j['runs'] if r['snapshot'] == '2026-10-08' and r['snapshot_column'] == 'net')

fails, oks = [], []


def check(name, cond, detail=''):
    (oks if cond else fails).append(name + (f' -- {detail}' if detail and not cond else ''))


def r2(v):
    return f'{v:.2f}'


# ── the frozen run is what the paper says it is ──────────────────────────────
check('frozen cohort is n=47', run['n_cohort'] == 47, run['n_cohort'])
check('frozen cohort is fully priced', run['n_priced'] == 47, run['n_priced'])
check('paper states n=47', '$n{=}47$' in text)
check('paper no longer states a 45-model cohort',
      'n{=}45' not in text and '45 models' not in text and '45 of 52' not in text)

# ── panel values are checked in their actual table, not by requiring math mode ─
TABLE_LABELS = {
    'frontier': 'tab:agent_validation',
    'budget': 'tab:regret_budget',
    'balanced': 'tab:regret_balanced',
}
def table_body(label):
    start = text.find('\\label{' + label + '}')
    if start < 0:
        return ''
    end = text.find('\\end{table}', start)
    return text[start:end] if end >= 0 else text[start:]

def row_has_value(table, method, value):
    token = re.compile(r'(?<![0-9.])' + re.escape(value) + r'(?![0-9.])')
    for line in table.splitlines():
        if method in line and '&' in line:
            cells = line.split('&')
            if len(cells) > 1 and token.search(cells[1]):
                return True
    return False

for arch in ('frontier', 'budget', 'balanced'):
    s = run['archetypes'][arch]['summary']
    table = table_body(TABLE_LABELS[arch])
    check(f'{arch}: results table is present', bool(table), TABLE_LABELS[arch])
    row_names = {'Proposed': 'Proposed', 'WSM': 'WSM (Linear)', 'TOPSIS': 'TOPSIS',
                 'Cobb-Douglas': 'Cobb', 'CES only': 'CES only'}
    for k in ('WSM', 'TOPSIS', 'Cobb-Douglas', 'CES only'):
        pass
    for k, row in row_names.items():
        value = r2(s[k]['mean_regret'])
        check(f'{arch}: {k} mean regret {value} appears in its table',
              row_has_value(table, row, value), f'{TABLE_LABELS[arch]} / {row} / {value}')

# ── the disclosed correction and the two new subsections ────────────────────
check('section: baseline parity and ablation present', '\\label{subsec:parity}' in text)
check('section: nominal weights vs swing present', '\\label{subsec:weights}' in text)
check('disclosure: rounded-ranking defect recorded',
      'ranked the proposed method on its \\emph{rounded} display score' in text)
check('disclosure: exact ranking is the shipped rule', 'scoreExact' in text)
check('component-ablation table present', '\\label{tab:component_ablation}' in text)
# ── the ablation numbers the paper quotes must match the ablation artifact ──
abl = json.load(io.open(ABLATION, encoding='utf-8'))['panels']['frontier']['rows']
by = {r['method']: r for r in abl}
check('ablation: full pipeline 0.09', r2(by['Full pipeline (shipped)']['mean_regret']) == '0.09')
check('ablation: removing deficit while retaining reward leaves regret unchanged',
      by['minus quality-deficit penalty (reward retained)']['mean_regret'] == 0.091
      and by['minus quality-deficit penalty (reward retained)']['changed_pick_tiers'] == 0)
check('ablation: removing reward while retaining deficit gives 1.28',
      by['minus frontier reward (deficit retained)']['mean_regret'] == 1.281
      and by['minus frontier reward (deficit retained)']['changed_pick_tiers'] == 2)
check('ablation: WSM plus deficit matches unpenalized WSM',
      by['WSM + deficit penalty']['mean_regret'] == by['WSM (6 coords)']['mean_regret'] == 0.487)
check('ablation: TOPSIS plus deficit matches unpenalized TOPSIS',
      by['TOPSIS + deficit penalty']['mean_regret'] == by['TOPSIS (6 coords)']['mean_regret'] == 0.487
      and by['TOPSIS + deficit penalty']['changed_pick_tiers'] == 0)
check('ablation: WSM plus both quality factors gives 0.09',
      by['WSM + deficit and frontier reward']['mean_regret'] == 0.091)
check('ablation: TOPSIS plus both quality factors remains 0.49',
      by['TOPSIS + deficit and frontier reward']['mean_regret'] == 0.487)
check('ablation: paired bootstrap metadata records 2,000 resamples',
      json.load(io.open(ABLATION, encoding='utf-8')).get('bootstrap', {}).get('reps') == 2000)
for arch in ('budget', 'balanced'):
    panel = json.load(io.open(ABLATION, encoding='utf-8'))['panels'][arch]['rows']
    methods = {row['method']: row for row in panel}
    check(f'ablation: {arch} WSM penalty changes no picks',
          methods['WSM + deficit penalty']['changed_pick_tiers'] == 0)
    check(f'ablation: {arch} TOPSIS penalty changes no picks',
          methods['TOPSIS + deficit penalty']['changed_pick_tiers'] == 0)
check('ablation: six-coordinate baselines match triplet',
      by['WSM (6 coords)']['mean_regret'] == by['WSM (triplet)']['mean_regret'] == 0.487)
check('ablation: parity claim stated', 'These coordinates move no tier\'s pick in this panel' in text)

if coauthor_text is not None:
    check('co-author draft distinguishes deficit factor from frontier reward',
          'removing the deficit factor leaves mean regret at $0.09$' in coauthor_text
          and 'removing the frontier reward raises it to $1.28$' in coauthor_text)
    check('co-author draft reports matched WSM and TOPSIS penalties',
          'WSM + deficit' in coauthor_text and 'TOPSIS + deficit' in coauthor_text)
    check('co-author draft reports the cross-intent pick result',
          'adding the production deficit factor to WSM or TOPSIS changes no tier picks' in coauthor_text)
    check('co-author draft has no obsolete penalty attribution',
          'removing the deficit penalty raises mean regret' not in coauthor_text.lower())

sw = json.load(io.open(SWING, encoding='utf-8'))
check('swing: cohort size matches the frozen cohort', sw['cohort'] == run['n_cohort'])
check('swing: all panels have a complete coordinate decomposition',
      all('influence' in panel for panel in sw['panels'].values()))

# ── retracted figures and narratives must be absent ─────────────────────────
absent = [
    ('best integrative rule under a cost-first', 'the retracted cost-first lead'),
    ('\\textbf{29.8}~(0/6)', 'the retracted cost-first value-for-money cell'),
    ('29.8$ against $24.2$', 'the retracted cost-first advantage sentence'),
    ('$1.2$ times', 'the retracted 1.2x efficiency claim'),
    ('$2.689$', 'the removed-profile harness figure'),
    ('$4.126$', 'the removed-profile harness figure'),
    ('superseded', 'the superseded-profile narrative'),
    ('earlier draft', 'the earlier-draft narrative'),
    ('all five formulations return the same ordering', 'the abstract claim contradicted by Table 1'),
    ('five of six budget tiers', 'the retracted balanced dominance claim'),
    ('Gemini 3.6 Flash', 'a pick from the removed-profile run'),
    ('Step 5 Preview      & 0.01', 'a pick from the rounded-ranking run'),
    ('0.834', 'a figure from the pre-rebuild cohort'),
]
for pat, why in absent:
    check(f'absent: {why}', pat not in text, f'still present: {pat!r}')

# ── the abstract is inside a Springer-length abstract ──────────────────────
m = re.search(r'\\abstract\{(.*?)\n', text, re.S)
words = len(m.group(1).split()) if m else 0
check('abstract is under 300 words', words < 300, f'{words} words')

# Cross-check every shared-utility table row against the harness output.
shared_path = 'experiments/intent_utility_eval.json'
if os.path.isfile(shared_path):
    shared = json.load(io.open(shared_path, encoding='utf-8'))
    expected = {
        'budget': {
            'Proposed (harmonized)': (0.0231, 0.8481, 0.0520, '6/6'),
            'WSM': (0.0000, 0.9247, 0.0738, '0/6'),
            'TOPSIS': (0.0105, 0.8983, 0.0750, '3/6'),
            'Cobb-Douglas': (0.0139, 0.9205, 0.1163, '5/6'),
            'CES rho=0.5': (0.0000, 0.9247, 0.0738, '0/6'),
        },
        'balanced': {
            'Proposed (harmonized)': (0.0181, 0.8969, 0.2138, '6/6'),
            'WSM': (0.0000, 0.9349, 0.3517, '5/6'),
            'TOPSIS': (0.0074, 0.9097, 0.2175, '5/6'),
            'Cobb-Douglas': (0.0000, 0.9349, 0.3517, '5/6'),
            'CES rho=0.5': (0.0000, 0.9349, 0.3517, '5/6'),
        },
    }
    for intent, methods in expected.items():
        rows = shared['intents'][intent]['results']
        for method, target in methods.items():
            r = rows[method]['linearUtility']
            actual = (round(r['meanUtilityRegret'], 4), round(r['meanQuality'], 4),
                      round(r['meanSessionCost'], 4), r['paretoDominatedQualityCost'])
            check(f'shared utility {intent}/{method}', actual == target,
                  f'expected {target}, got {actual}')
else:
    check('shared-utility harness output exists', False, shared_path)

print(f'{len(oks)} checks passed')
for f in fails:
    print('  FAIL ' + f)
sys.exit(1 if fails else 0)
