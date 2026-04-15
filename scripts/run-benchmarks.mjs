import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRepoAnalysis, buildReviewPacket } from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const benchmarksDir = path.join(repoRoot, 'benchmarks');
const examplesDir = path.join(repoRoot, 'examples');

const benchmarkTargets = [
  {
    slug: 'openai-openai-node',
    owner: 'openai',
    repo: 'openai-node',
    ref: 'master',
    description: 'Modern SDK repo with TypeScript-heavy API surface.',
  },
  {
    slug: 'fastapi-fastapi',
    owner: 'fastapi',
    repo: 'fastapi',
    ref: 'master',
    description: 'Python framework repo with docs and server-side patterns.',
  },
];

function nowIso() {
  return new Date().toISOString();
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

async function ensureDirs() {
  await mkdir(benchmarksDir, { recursive: true });
  await mkdir(examplesDir, { recursive: true });
}

async function runOneBenchmark(target) {
  try {
    const analysisStarted = performance.now();
    const analysis = await buildRepoAnalysis({
      owner: target.owner,
      repo: target.repo,
      ref: target.ref,
      maxFiles: 12,
      maxRepoChars: 18000,
      maxFileChars: 2500,
    });
    const analysisDurationMs = Math.round(performance.now() - analysisStarted);

    let review = null;
    let reviewDurationMs = null;
    let reviewError = null;

    try {
      const reviewStarted = performance.now();
      review = await buildReviewPacket(analysis);
      reviewDurationMs = Math.round(performance.now() - reviewStarted);
    } catch (error) {
      reviewError = error instanceof Error ? error.message : String(error);
    }

    const result = {
      generated_at: nowIso(),
      target,
      status: 'completed',
      metrics: {
        analysis_duration_ms: analysisDurationMs,
        review_duration_ms: reviewDurationMs,
        sampled_file_count: analysis.files.sampled_files.length,
        unavailable_file_count: analysis.files.unavailable_files.length,
        truncated_file_count: analysis.files.truncated_files.length,
        limited_coverage: analysis.limitations.limited_coverage,
      },
      analysis,
      review,
      review_error: reviewError,
    };

    const resultPath = path.join(benchmarksDir, `${target.slug}.json`);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return { result, resultPath };
  } catch (error) {
    const result = {
      generated_at: nowIso(),
      target,
      status: 'blocked',
      error: error instanceof Error ? error.message : String(error),
      metrics: {
        analysis_duration_ms: null,
        review_duration_ms: null,
        sampled_file_count: 0,
        unavailable_file_count: 0,
        truncated_file_count: 0,
        limited_coverage: true,
      },
      analysis: null,
      review: null,
      review_error: null,
    };
    const resultPath = path.join(benchmarksDir, `${target.slug}.json`);
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return { result, resultPath };
  }
}

function buildSummaryEntry(result, resultPath) {
  return {
    slug: result.target.slug,
    repo: `${result.target.owner}/${result.target.repo}`,
    description: result.target.description,
    status: result.status,
    analysis_duration_ms: result.metrics.analysis_duration_ms,
    review_duration_ms: result.metrics.review_duration_ms,
    sampled_file_count: result.metrics.sampled_file_count,
    limited_coverage: result.metrics.limited_coverage,
    risk: result.review?.packet?.risk ?? null,
    summary: safeString(result.review?.packet?.summary),
    error: result.error ?? result.review_error,
    artifact_path: path.relative(repoRoot, resultPath).replaceAll('\\', '/'),
  };
}

async function main() {
  await ensureDirs();

  const summary = {
    generated_at: nowIso(),
    benchmark_targets: [],
  };

  let sampleReviewPacketWritten = false;

  for (const target of benchmarkTargets) {
    const { result, resultPath } = await runOneBenchmark(target);
    summary.benchmark_targets.push(buildSummaryEntry(result, resultPath));

    if (!sampleReviewPacketWritten && result.review?.packet) {
      const samplePacket = {
        generated_at: result.generated_at,
        source_repo: `${target.owner}/${target.repo}`,
        analysis_type: result.review.analysis_type,
        model: result.review.model,
        packet: result.review.packet,
      };
      await writeFile(
        path.join(examplesDir, 'sample-review-packet.json'),
        `${JSON.stringify(samplePacket, null, 2)}\n`,
        'utf8',
      );
      sampleReviewPacketWritten = true;
    }
  }

  await writeFile(
    path.join(benchmarksDir, 'benchmark-summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
