import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const nowIso = () => new Date().toISOString();
const asPositiveNumber = (value, fallback, minimum = 1) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
};

const config = {
  githubToken: clean(process.env.GITHUB_TOKEN),
  openAiApiKey: clean(process.env.OPENAI_API_KEY),
  openAiModel: clean(process.env.OPENAI_MODEL) || 'gpt-4.1-mini',
  httpMaxAttempts: asPositiveNumber(process.env.HTTP_MAX_ATTEMPTS, 3),
  httpRetryBaseMs: asPositiveNumber(process.env.HTTP_RETRY_BASE_MS, 1000, 50),
  httpTimeoutMs: asPositiveNumber(process.env.HTTP_TIMEOUT_MS, 30_000, 500),
  openAiTimeoutMs: asPositiveNumber(process.env.OPENAI_TIMEOUT_MS, 60_000, 500),
  defaultMaxRepoFiles: asPositiveNumber(process.env.MAX_REPO_FILES, 20),
  defaultMaxRepoChars: asPositiveNumber(process.env.MAX_REPO_CHARS, 24_000),
  defaultMaxRepoFileChars: asPositiveNumber(process.env.MAX_REPO_FILE_CHARS, 4_000),
  defaultMaxPatchChars: asPositiveNumber(process.env.MAX_PATCH_CHARS, 20_000),
  defaultMaxPatchFileChars: asPositiveNumber(process.env.MAX_PATCH_FILE_CHARS, 3_500),
  host: clean(process.env.MCP_HOST) || '127.0.0.1',
  port: asPositiveNumber(process.env.MCP_PORT, 8787),
  path: clean(process.env.MCP_PATH) || '/mcp',
  authToken: clean(process.env.MCP_AUTH_TOKEN),
};

const DEFAULT_PRIORITY_PATHS = [
  'README.md',
  'README',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.github/workflows/ci.yml',
  '.github/workflows/main.yml',
  '.env.example',
];

const EXCLUDE_PATH_PATTERNS = [
  /^\.git\//i,
  /^node_modules\//i,
  /^dist\//i,
  /^build\//i,
  /^coverage\//i,
  /^vendor\//i,
  /^\.next\//i,
  /^out\//i,
  /^target\//i,
];

const ALLOWED_EXTENSIONS = [
  '.md',
  '.txt',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.java',
  '.go',
  '.rb',
  '.php',
  '.cs',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.env',
  '.sql',
  '.sh',
  '.ps1',
  '.gradle',
];

const SPECIAL_NAMES = ['dockerfile', 'makefile', 'readme', 'license'];
const SECRET_REGEX =
  /(AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----|api[_-]?key\s*[:=]\s*['"][^'"]{8,}|secret\s*[:=]\s*['"][^'"]{8,}|password\s*[:=]\s*['"][^'"]{6,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z\-_]{35})/i;

function requireOpenAiApiKey() {
  if (!config.openAiApiKey) {
    throw new Error('Missing required env var OPENAI_API_KEY');
  }
}

function truncateText(value, maxLength) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactList(values, maxItems = 8, maxLen = 220) {
  return (Array.isArray(values) ? values : [])
    .map(clean)
    .filter(Boolean)
    .slice(0, maxItems)
    .map((value) => truncateText(value, maxLen));
}

function ensureRisk(value) {
  const normalized = clean(value).toLowerCase();
  return normalized === 'low' || normalized === 'medium' || normalized === 'high' ? normalized : 'medium';
}

function addUnique(target, value) {
  const normalized = clean(value);
  if (!normalized || target.includes(normalized)) return;
  target.push(normalized);
}

function decodeBase64(value) {
  return Buffer.from(String(value || '').replace(/\n/g, ''), 'base64').toString('utf8');
}

function encodePath(path) {
  return String(path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function isExcludedPath(path) {
  return EXCLUDE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

function hasAllowedType(path) {
  const lower = String(path).toLowerCase();
  if (SPECIAL_NAMES.some((name) => lower.endsWith(name))) return true;
  return ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, options, label, timeoutMs = config.httpTimeoutMs) {
  const attempts = config.httpMaxAttempts;
  const baseDelay = config.httpRetryBaseMs;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const rawText = await response.text();
      const contentType = response.headers.get('content-type') || '';
      const parsedBody = contentType.includes('application/json') && rawText ? JSON.parse(rawText) : rawText;

      if (!response.ok) {
        const message =
          parsedBody?.message ||
          parsedBody?.error?.message ||
          parsedBody?.error ||
          rawText ||
          `HTTP ${response.status}`;
        const retryable = response.status === 429 || response.status === 403 || response.status >= 500;
        if (!retryable || attempt === attempts) {
          throw new Error(`${label} failed after ${attempt} attempt(s). Status=${response.status}. ${message}`);
        }
        await wait(baseDelay * 2 ** (attempt - 1));
        continue;
      }

      return parsedBody;
    } catch (error) {
      const isAbort = error?.name === 'AbortError';
      const retryable = isAbort || /ECONN|ENOTFOUND|fetch failed/i.test(error?.message || '');
      if (!retryable || attempt === attempts) {
        throw new Error(`${label} failed after ${attempt} attempt(s). ${error?.message || 'Unknown request failure'}`);
      }
      await wait(baseDelay * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`${label} failed unexpectedly`);
}

function githubHeaders({ includeAuth = true } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'repocop-mcp',
  };
  if (includeAuth && config.githubToken) {
    headers.Authorization = `Bearer ${config.githubToken}`;
  }
  return headers;
}

async function requestGitHubJson(url, label) {
  try {
    return await requestJson(
      url,
      { headers: githubHeaders({ includeAuth: true }) },
      label,
    );
  } catch (error) {
    const message = error?.message || '';
    const shouldRetryAnonymously =
      config.githubToken && /Status=401/i.test(message);
    if (!shouldRetryAnonymously) {
      throw error;
    }
    return requestJson(
      url,
      { headers: githubHeaders({ includeAuth: false }) },
      `${label} (anonymous retry)`,
    );
  }
}

async function getRepository(owner, repo) {
  return requestGitHubJson(
    `https://api.github.com/repos/${owner}/${repo}`,
    'Get repository metadata',
  );
}

async function getBranchHead(owner, repo, ref) {
  return requestGitHubJson(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    'Get branch head commit',
  );
}

async function getRepositoryLanguages(owner, repo) {
  try {
    return await requestGitHubJson(
      `https://api.github.com/repos/${owner}/${repo}/languages`,
      'Get repository languages',
    );
  } catch {
    return {};
  }
}

async function getRepositoryTree(owner, repo, ref) {
  return requestGitHubJson(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    'Get repository tree',
  );
}

async function getRecentCommits(owner, repo, ref, count = 5) {
  try {
    return await requestGitHubJson(
      `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(ref)}&per_page=${count}`,
      'Get recent commits',
    );
  } catch {
    return [];
  }
}

async function getFileContent(owner, repo, path, ref) {
  return requestGitHubJson(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    `Get file content ${path}`,
  );
}

async function compareRefs(owner, repo, baseRef, headRef) {
  return requestGitHubJson(
    `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`,
    'Compare repository refs',
  );
}

export async function buildRepoAnalysis({
  owner,
  repo,
  ref,
  maxFiles = config.defaultMaxRepoFiles,
  maxRepoChars = config.defaultMaxRepoChars,
  maxFileChars = config.defaultMaxRepoFileChars,
}) {
  const repository = await getRepository(owner, repo);
  const branch = clean(ref).replace(/^refs\/heads\//, '') || clean(repository.default_branch) || 'main';
  const head = await getBranchHead(owner, repo, branch);
  const tree = await getRepositoryTree(owner, repo, branch);
  const languages = await getRepositoryLanguages(owner, repo);
  const recentCommits = await getRecentCommits(owner, repo, branch);

  const allBlobs = Array.isArray(tree?.tree)
    ? tree.tree.filter((entry) => entry && entry.type === 'blob' && entry.path)
    : [];

  const blobByPath = new Map(allBlobs.map((blob) => [String(blob.path), blob]));
  const selectedPaths = [];
  const addPath = (path) => {
    if (!path || selectedPaths.includes(path) || isExcludedPath(path)) return;
    selectedPaths.push(path);
  };

  for (const path of DEFAULT_PRIORITY_PATHS) {
    if (blobByPath.has(path)) addPath(path);
  }

  const candidates = allBlobs
    .map((blob) => ({ path: String(blob.path), size: Number(blob.size || 0) }))
    .filter((blob) => !isExcludedPath(blob.path) && hasAllowedType(blob.path))
    .sort((left, right) => left.path.length - right.path.length || left.size - right.size);

  for (const candidate of candidates) {
    if (selectedPaths.length >= maxFiles) break;
    addPath(candidate.path);
  }

  let usedChars = 0;
  const sampledFiles = [];
  const unavailableFiles = [];
  const truncatedFiles = [];

  for (const path of selectedPaths) {
    if (usedChars >= maxRepoChars) {
      truncatedFiles.push(path);
      continue;
    }

    try {
      const file = await getFileContent(owner, repo, path, branch);
      if (!file || file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
        unavailableFiles.push(path);
        continue;
      }

      let text;
      try {
        text = decodeBase64(file.content);
      } catch {
        unavailableFiles.push(path);
        continue;
      }

      if (!text || /\x00/.test(text)) {
        unavailableFiles.push(path);
        continue;
      }

      const remaining = Math.max(0, maxRepoChars - usedChars);
      const budget = Math.min(maxFileChars, remaining);
      let excerpt = text;
      let coverage = 'full';

      if (text.length > budget) {
        excerpt = text.slice(0, budget);
        coverage = 'truncated';
        truncatedFiles.push(path);
      }

      usedChars += excerpt.length;
      sampledFiles.push({
        path,
        size: Number(file.size || 0),
        coverage,
        excerpt,
      });
    } catch {
      unavailableFiles.push(path);
    }
  }

  const commitSummaries = (Array.isArray(recentCommits) ? recentCommits : [])
    .map((commit) => ({
      sha: clean(commit?.sha).slice(0, 12),
      author: clean(commit?.commit?.author?.name),
      message: clean(commit?.commit?.message).split('\n')[0],
    }))
    .filter((commit) => commit.sha && commit.message);

  return {
    analysis_type: 'repo',
    generated_at: nowIso(),
    repository: {
      owner,
      repo,
      full_name: repository.full_name || `${owner}/${repo}`,
      description: repository.description || '',
      default_branch: repository.default_branch || branch,
      branch,
      url: repository.html_url || `https://github.com/${owner}/${repo}`,
      visibility: repository.private ? 'private' : 'public',
      stars: Number(repository.stargazers_count || 0),
      forks: Number(repository.forks_count || 0),
      open_issues: Number(repository.open_issues_count || 0),
      pushed_at: repository.pushed_at || '',
      topics: Array.isArray(repository.topics) ? repository.topics : [],
      languages,
      head_commit: clean(head?.sha) || 'unknown',
      recent_commits: commitSummaries,
    },
    files: {
      total_blob_count: allBlobs.length,
      selected_paths: selectedPaths,
      sampled_files: sampledFiles,
      unavailable_files: unavailableFiles,
      truncated_files: truncatedFiles,
      limits: {
        max_repo_files: maxFiles,
        max_repo_chars: maxRepoChars,
        max_file_chars: maxFileChars,
        included_chars: usedChars,
      },
      tree_truncated: Boolean(tree?.truncated),
    },
    limitations: {
      sampled_file_count: sampledFiles.length,
      unavailable_file_count: unavailableFiles.length,
      truncated_file_count: truncatedFiles.length,
      limited_coverage:
        Boolean(tree?.truncated) || unavailableFiles.length > 0 || truncatedFiles.length > 0 || sampledFiles.length === 0,
    },
    security_signals: {
      suspected_secret_exposure: sampledFiles.some((file) => SECRET_REGEX.test(file.excerpt)),
    },
  };
}

export async function buildChangeSummary({
  owner,
  repo,
  baseRef,
  headRef,
  maxFiles = config.defaultMaxRepoFiles,
  maxPatchChars = config.defaultMaxPatchChars,
  maxPatchFileChars = config.defaultMaxPatchFileChars,
}) {
  const comparison = await compareRefs(owner, repo, baseRef, headRef);
  const files = Array.isArray(comparison?.files) ? comparison.files : [];
  const selectedFiles = files.slice(0, maxFiles);
  const truncatedFiles = [];
  const missingPatchFiles = [];
  const sampledFiles = [];
  let usedChars = 0;

  for (const file of selectedFiles) {
    const patch = typeof file.patch === 'string' ? file.patch : '';
    let patchExcerpt = patch;
    let patchCoverage = 'full';

    if (!patch) {
      patchCoverage = 'missing';
      missingPatchFiles.push(file.filename);
      patchExcerpt = '';
    } else {
      const remaining = Math.max(0, maxPatchChars - usedChars);
      const budget = Math.min(maxPatchFileChars, remaining);
      if (patch.length > budget) {
        patchExcerpt = patch.slice(0, budget);
        patchCoverage = 'truncated';
        truncatedFiles.push(file.filename);
      }
      usedChars += patchExcerpt.length;
    }

    sampledFiles.push({
      path: file.filename,
      status: file.status,
      additions: Number(file.additions || 0),
      deletions: Number(file.deletions || 0),
      changes: Number(file.changes || 0),
      previous_filename: file.previous_filename || '',
      patch_coverage: patchCoverage,
      patch_excerpt: patchExcerpt,
    });
  }

  const commitSummaries = (Array.isArray(comparison?.commits) ? comparison.commits : [])
    .map((commit) => ({
      sha: clean(commit?.sha).slice(0, 12),
      author: clean(commit?.commit?.author?.name),
      message: clean(commit?.commit?.message).split('\n')[0],
    }))
    .filter((commit) => commit.sha && commit.message);

  return {
    analysis_type: 'changes',
    generated_at: nowIso(),
    repository: {
      owner,
      repo,
      full_name: comparison?.base_commit?.commit?.tree?.url
        ? `${owner}/${repo}`
        : `${owner}/${repo}`,
      compare_url: comparison?.html_url || `https://github.com/${owner}/${repo}/compare/${baseRef}...${headRef}`,
      base_ref: baseRef,
      head_ref: headRef,
      status: clean(comparison?.status) || 'unknown',
      ahead_by: Number(comparison?.ahead_by || 0),
      behind_by: Number(comparison?.behind_by || 0),
      total_commits: Number(comparison?.total_commits || commitSummaries.length),
    },
    changes: {
      total_changed_files: files.length,
      selected_file_count: sampledFiles.length,
      sampled_files: sampledFiles,
      missing_patch_files: missingPatchFiles,
      truncated_patch_files: truncatedFiles,
      commits: commitSummaries,
      limits: {
        max_files: maxFiles,
        max_patch_chars: maxPatchChars,
        max_patch_file_chars: maxPatchFileChars,
        included_patch_chars: usedChars,
      },
    },
    limitations: {
      missing_patch_count: missingPatchFiles.length,
      truncated_patch_count: truncatedFiles.length,
      limited_coverage: missingPatchFiles.length > 0 || truncatedFiles.length > 0 || sampledFiles.length === 0 || files.length > maxFiles,
    },
    security_signals: {
      suspected_secret_exposure: sampledFiles.some((file) => SECRET_REGEX.test(file.patch_excerpt)),
    },
  };
}

function buildJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'summary',
      'risk',
      'risk_reasoning',
      'architecture_observations',
      'code_quality_findings',
      'security_findings',
      'test_coverage_gaps',
      'recommended_next_steps',
      'questions_for_maintainer',
    ],
    properties: {
      summary: { type: 'string' },
      risk: { type: 'string', enum: ['low', 'medium', 'high'] },
      risk_reasoning: { type: 'array', items: { type: 'string' } },
      architecture_observations: { type: 'array', items: { type: 'string' } },
      code_quality_findings: { type: 'array', items: { type: 'string' } },
      security_findings: { type: 'array', items: { type: 'string' } },
      test_coverage_gaps: { type: 'array', items: { type: 'string' } },
      recommended_next_steps: { type: 'array', items: { type: 'string' } },
      questions_for_maintainer: { type: 'array', items: { type: 'string' } },
    },
  };
}

export async function buildReviewPacket(analysis) {
  requireOpenAiApiKey();

  const reviewType = analysis?.analysis_type === 'changes' ? 'change review' : 'repository review';
  const schema = buildJsonSchema();

  const response = await requestJson(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.openAiModel,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: [
              `You are a senior software reviewer producing a ${reviewType} packet.`,
              'Use only the provided GitHub metadata and sampled content.',
              'Do not hallucinate unseen files, functions, classes, tests, or dependencies.',
              'If coverage is limited, explicitly state reduced confidence and what is missing.',
              'Focus on correctness, maintainability, security, performance, and testing gaps.',
              'Return strict JSON with exactly these keys: summary, risk, risk_reasoning, architecture_observations, code_quality_findings, security_findings, test_coverage_gaps, recommended_next_steps, questions_for_maintainer.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Analysis JSON:\n${JSON.stringify(analysis)}`,
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'repocop_review_packet',
            strict: true,
            schema,
          },
        },
      }),
    },
    'Generate review packet',
    config.openAiTimeoutMs,
  );

  const content = response?.choices?.[0]?.message?.content;
  const parsed = typeof content === 'string' ? JSON.parse(content) : content;

  const packet = {
    summary: clean(parsed?.summary) || 'Automated review could not produce a confident summary from the available data.',
    risk: ensureRisk(parsed?.risk),
    risk_reasoning: compactList(parsed?.risk_reasoning, 8),
    architecture_observations: compactList(parsed?.architecture_observations, 8),
    code_quality_findings: compactList(parsed?.code_quality_findings, 10),
    security_findings: compactList(parsed?.security_findings, 10),
    test_coverage_gaps: compactList(parsed?.test_coverage_gaps, 10),
    recommended_next_steps: compactList(parsed?.recommended_next_steps, 10),
    questions_for_maintainer: compactList(parsed?.questions_for_maintainer, 8),
  };

  if (analysis?.limitations?.limited_coverage) {
    if (packet.risk === 'low') packet.risk = 'medium';
    if (analysis.analysis_type === 'changes') {
      addUnique(
        packet.risk_reasoning,
        `Patch coverage is limited: ${analysis.limitations.missing_patch_count || 0} missing and ${analysis.limitations.truncated_patch_count || 0} truncated patch sample(s).`,
      );
      addUnique(packet.questions_for_maintainer, 'Can you share the missing or larger diff sections for higher-confidence review coverage?');
    } else {
      addUnique(
        packet.risk_reasoning,
        `Repository coverage is limited: sampled ${analysis.limitations.sampled_file_count || 0} file(s), ${analysis.limitations.unavailable_file_count || 0} unavailable, ${analysis.limitations.truncated_file_count || 0} truncated.`,
      );
      addUnique(packet.questions_for_maintainer, 'Can you share additional core files or modules for deeper review coverage?');
    }
  }

  if (analysis?.security_signals?.suspected_secret_exposure) {
    packet.risk = 'high';
    addUnique(packet.security_findings, 'Potential secret, token, or private key exposure detected in sampled content.');
    addUnique(packet.recommended_next_steps, 'Remove exposed secret material from repository content and configuration files.');
    addUnique(packet.recommended_next_steps, 'Rotate compromised credentials and purge them from git history if they were committed.');
  }

  if (packet.risk === 'high') {
    addUnique(packet.recommended_next_steps, 'Require explicit human review before deployment or release.');
    addUnique(packet.test_coverage_gaps, 'Add regression and security-focused validation for critical paths before shipping.');
  }

  return {
    generated_at: nowIso(),
    analysis_type: analysis?.analysis_type || 'repo',
    model: config.openAiModel,
    packet,
  };
}

function toolResponse(result) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

function createServer() {
  const server = new McpServer({
    name: 'repocop-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'analyze_repo',
    {
      title: 'Analyze Repository',
      description: 'Fetch repository metadata, sample important files, and return a coverage-aware repository analysis packet.',
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        ref: z.string().optional(),
        maxFiles: z.number().int().min(1).max(100).optional(),
        maxRepoChars: z.number().int().min(1000).max(200000).optional(),
        maxFileChars: z.number().int().min(250).max(20000).optional(),
      }),
    },
    async ({ owner, repo, ref, maxFiles, maxRepoChars, maxFileChars }) =>
      toolResponse(await buildRepoAnalysis({ owner, repo, ref, maxFiles, maxRepoChars, maxFileChars })),
  );

  server.registerTool(
    'summarize_changes',
    {
      title: 'Summarize Changes',
      description: 'Compare two refs in a repository, sample changed files and patches, and report diff coverage limits.',
      inputSchema: z.object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        baseRef: z.string().min(1),
        headRef: z.string().min(1),
        maxFiles: z.number().int().min(1).max(100).optional(),
        maxPatchChars: z.number().int().min(1000).max(200000).optional(),
        maxPatchFileChars: z.number().int().min(250).max(20000).optional(),
      }),
    },
    async ({ owner, repo, baseRef, headRef, maxFiles, maxPatchChars, maxPatchFileChars }) =>
      toolResponse(
        await buildChangeSummary({
          owner,
          repo,
          baseRef,
          headRef,
          maxFiles,
          maxPatchChars,
          maxPatchFileChars,
        }),
      ),
  );

  server.registerTool(
    'generate_review_packet',
    {
      title: 'Generate Review Packet',
      description:
        'Generate a strict JSON review packet from fresh repository analysis or change analysis using the configured OpenAI model.',
      inputSchema: z.object({
        reviewType: z.enum(['repo', 'changes']),
        owner: z.string().min(1),
        repo: z.string().min(1),
        ref: z.string().optional(),
        baseRef: z.string().optional(),
        headRef: z.string().optional(),
        maxFiles: z.number().int().min(1).max(100).optional(),
        maxRepoChars: z.number().int().min(1000).max(200000).optional(),
        maxFileChars: z.number().int().min(250).max(20000).optional(),
        maxPatchChars: z.number().int().min(1000).max(200000).optional(),
        maxPatchFileChars: z.number().int().min(250).max(20000).optional(),
      }),
    },
    async (input) => {
      let analysis;
      if (input.reviewType === 'changes') {
        if (!clean(input.baseRef) || !clean(input.headRef)) {
          throw new Error('generate_review_packet with reviewType="changes" requires both baseRef and headRef');
        }
        analysis = await buildChangeSummary({
          owner: input.owner,
          repo: input.repo,
          baseRef: input.baseRef,
          headRef: input.headRef,
          maxFiles: input.maxFiles,
          maxPatchChars: input.maxPatchChars,
          maxPatchFileChars: input.maxPatchFileChars,
        });
      } else {
        analysis = await buildRepoAnalysis({
          owner: input.owner,
          repo: input.repo,
          ref: input.ref,
          maxFiles: input.maxFiles,
          maxRepoChars: input.maxRepoChars,
          maxFileChars: input.maxFileChars,
        });
      }

      const review = await buildReviewPacket(analysis);
      return toolResponse({
        ...review,
        analysis,
      });
    },
  );

  return server;
}

export function createApp() {
  const app = createMcpExpressApp({ host: config.host });
  app.use((request, _response, next) => {
    request.setEncoding?.('utf8');
    next();
  });

  app.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      service: 'repocop-mcp',
      timestamp: nowIso(),
      mcp_path: config.path,
    });
  });

  app.use((request, response, next) => {
    if (config.authToken && request.path === config.path) {
      const expected = `Bearer ${config.authToken}`;
      if (request.headers.authorization !== expected) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }
    next();
  });

  const sessions = new Map();

  app.all(config.path, async (request, response) => {
    try {
      const sessionId = request.headers['mcp-session-id'];
      let state = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

      if (!state) {
        state = { server: null, transport: null };
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, state);
          },
        });

        state.server = server;
        state.transport = transport;

        transport.onclose = async () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          await server.close();
        };

        await server.connect(transport);
      }

      await state.transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          error: 'Internal Server Error',
          message: error?.message || 'Unknown MCP server error',
        });
      }
    }
  });

  return app;
}

export function startServer() {
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`RepoCop MCP server listening on http://${config.host}:${config.port}${config.path}`);
  });

  return {
    app,
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            if (error.code === 'ERR_SERVER_NOT_RUNNING') {
              resolve();
              return;
            }
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  startServer();
}
