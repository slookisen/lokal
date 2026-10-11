// Operator diagnostic for this one public catalogue record. Every admin POST
// below is a dry run; there are no inputs, apply mode, orders or emails.
import { writeFile } from 'node:fs/promises';

const origin = 'https://opplevagent.no';
const id = '924a30d5-b9de-4926-947d-cd9a7a0e3bfc';
const report = { checked_at: new Date().toISOString(), id, dry_run: true };
const adminKey = process.env.ADMIN_KEY;
if (!adminKey) throw new Error('The existing ADMIN_KEY repository secret is unavailable.');

async function request(path, { admin = false, body } = {}) {
  const response = await fetch(origin + path, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json',
      ...(admin ? { 'X-Admin-Key': adminKey } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Catalogue endpoint returned HTTP ${response.status}.`);
  return response.json();
}

try {
  const publicResult = await request(`/api/opplevelser/${id}`);
  const row = publicResult.experience;
  if (row?.id !== id) throw new Error('The public response did not identify the requested record.');
  report.public_record = { id: row.id, title: row.title, price_from: row.price_from,
    price_unit: row.price_unit, duration_minutes_min: row.duration_minutes_min,
    duration_minutes_max: row.duration_minutes_max, description: row.description };

  report.corrections_dry_run = await request('/api/opplevelser/admin/experiences-data-corrections', {
    admin: true,
    body: { dry_run: true, batch_label: 'chatgpt-review-2026-10-11-arctic-explorer', items: [
      { id, field: 'duration', action: 'correct', expected_current: '180', new_value: '240',
        source_url: 'https://arcticexplorer.no/', quote: 'Duration: 4 hours.', confidence: 'high' },
      { id, field: 'price_from', action: 'correct', expected_current: '800', new_value: '990',
        source_url: 'https://arcticexplorer.no/', quote: 'ADULT: 990,- NOK', confidence: 'high' },
    ] },
  });
  if (report.corrections_dry_run.dry_run !== true || report.corrections_dry_run.totals?.applied !== 0) {
    throw new Error('Unexpected diagnostic response; inspect the report before any further action.');
  }

  const provenance = await request(`/api/opplevelser/admin/experiences/${id}/provenance`, { admin: true });
  report.description_provenance = {
    content_source: provenance.experience?.content_source,
    description_evidence: provenance.experience?.content_field_evidence?.description,
    published: provenance.experience?.published,
  };
  const candidates = await request('/api/opplevelser/admin/experiences-description-candidates?limit=50', { admin: true });
  // Do not expose unrelated catalogue rows or any account/owner information.
  report.description_candidate = candidates.items?.find((item) => item.id === id) ?? null;
  report.candidate_scope = 'First 50 eligible rows only; absence here does not establish ineligibility.';
  report.description_rules = candidates.rules;
  console.log(JSON.stringify({ id, dry_run: true,
    corrections: report.corrections_dry_run.totals,
    description_candidate_in_first_50: Boolean(report.description_candidate) }));
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Catalogue check failed.';
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await writeFile('catalogue-check-report.json', JSON.stringify(report, null, 2) + '\n');
}
