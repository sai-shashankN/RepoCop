$normalizeCode = @'
const inputItems = $input.all();
const outputs = [];

for (const item of inputItems) {
  const body = item.json.body ?? item.json;
  const receivedAt = new Date().toISOString();

  if (body && body.pull_request && body.repository) {
    const action = body.action || '';
    const allowed = ['opened', 'synchronize'];
    const owner = body.repository?.owner?.login || body.repository?.owner?.name || '';
    const repo = body.repository?.name || '';
    const pr = body.pull_request || {};

    if (!allowed.includes(action)) {
      outputs.push({
        json: {
          skip: true,
          skip_reason: `Ignoring unsupported pull_request action: ${action || 'unknown'}. Supported: opened, synchronize.`,
          trigger_mode: 'automatic',
          event_action: action || 'unknown',
          owner,
          repo,
          pr_number: Number(pr.number || 0),
          pr_url: pr.html_url || '',
          reviewed_sha: pr.head?.sha || '',
          pr_identifier: owner && repo && pr.number ? `${owner}/${repo}#${pr.number}` : 'unknown',
          received_at: receivedAt,
        },
      });
      continue;
    }

    outputs.push({
      json: {
        skip: false,
        skip_reason: '',
        trigger_mode: 'automatic',
        event_action: action,
        owner,
        repo,
        pr_number: Number(pr.number || 0),
        pr_url: pr.html_url || '',
        reviewed_sha: pr.head?.sha || '',
        pr_identifier: owner && repo && pr.number ? `${owner}/${repo}#${pr.number}` : 'unknown',
        received_at: receivedAt,
      },
    });
    continue;
  }

  const prUrl = body?.pr_url || body?.prUrl || body?.url || body?.pull_request_url || body?.pullRequestUrl || '';
  const match = typeof prUrl === 'string'
    ? prUrl.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)(?:\/.*)?$/i)
    : null;

  if (!match) {
    outputs.push({
      json: {
        skip: true,
        skip_reason: 'Manual mode requires a valid GitHub PR URL in body.pr_url (for example: https://github.com/owner/repo/pull/123).',
        trigger_mode: 'manual',
        event_action: 'manual_request',
        owner: '',
        repo: '',
        pr_number: 0,
        pr_url: prUrl || '',
        reviewed_sha: '',
        pr_identifier: 'unknown',
        received_at: receivedAt,
      },
    });
    continue;
  }

  const owner = match[1];
  const repo = match[2];
  const prNumber = Number(match[3]);
  const normalizedUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;

  outputs.push({
    json: {
      skip: false,
      skip_reason: '',
      trigger_mode: 'manual',
      event_action: 'manual_request',
      owner,
      repo,
      pr_number: prNumber,
      pr_url: normalizedUrl,
      reviewed_sha: '',
      pr_identifier: `${owner}/${repo}#${prNumber}`,
      received_at: receivedAt,
    },
  });
}

return outputs;
'@

$reviewCode = @'
const input = $input.first().json;
const staticData = $getWorkflowStaticData('global');
if (!staticData.lastReviewedByPr || typeof staticData.lastReviewedByPr !== 'object') {
  staticData.lastReviewedByPr = {};
}
if (!Array.isArray(staticData.auditLog)) {
  staticData.auditLog = [];
}

const destinationMode = (($env.DESTINATION_MODE || 'discord') + '').toLowerCase();
const nowIso = new Date().toISOString();
let prIdentifier = input.pr_identifier || 'unknown';
let commitSha = input.reviewed_sha || 'unknown';

const addUnique = (list, value) => {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
};

const trimList = (list, maxItems = 8, maxLen = 220) => {
  return list
    .filter((v) => typeof v === 'string')
    .map((v) => v.replace(/\s+/g, ' ').trim())
    .filter((v) => v.length > 0)
    .slice(0, maxItems)
    .map((v) => (v.length > maxLen ? `${v.slice(0, maxLen - 3)}...` : v));
};

const ensureString = (value, fallback = '') => {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
};

const ensureRisk = (value) => {
  const normalized = (value || '').toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') return normalized;
  return 'medium';
};

const pushAudit = (riskLevel, messageLink = '', note = '') => {
  const entry = {
    timestamp: new Date().toISOString(),
    pr_identifier: prIdentifier,
    commit_sha: commitSha,
    risk_level: riskLevel,
    message_link: messageLink || '',
  };
  if (note) entry.note = note;
  staticData.auditLog.unshift(entry);
  staticData.auditLog = staticData.auditLog.slice(0, 500);
  return entry;
};

const sleep = async (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestWithRetry = async (options, label) => {
  const attempts = Math.max(1, Number($env.HTTP_MAX_ATTEMPTS || 3));
  const baseDelayMs = Math.max(200, Number($env.HTTP_RETRY_BASE_MS || 1000));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await this.helpers.httpRequest(options);
    } catch (error) {
      const status = error?.statusCode || error?.response?.statusCode || error?.response?.status || 0;
      const message = error?.response?.body?.message || error?.message || 'Unknown request failure';
      const retryable = status === 0 || status === 429 || status >= 500 || status === 403;

      if (!retryable || attempt === attempts) {
        throw new Error(`${label} failed after ${attempt} attempt(s). Status=${status || 'n/a'}. ${message}`);
      }

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
};

const buildPacket = (raw) => {
  const packet = {
    summary: ensureString(raw?.summary, 'Automated review could not create a confident summary from available diffs.'),
    risk: ensureRisk(raw?.risk),
    risk_reasoning: trimList(Array.isArray(raw?.risk_reasoning) ? raw.risk_reasoning : [], 8),
    key_changes: trimList(Array.isArray(raw?.key_changes) ? raw.key_changes : [], 8),
    files_of_interest: trimList(Array.isArray(raw?.files_of_interest) ? raw.files_of_interest : [], 12),
    suggested_review_comments: trimList(Array.isArray(raw?.suggested_review_comments) ? raw.suggested_review_comments : [], 10),
    test_checklist: trimList(Array.isArray(raw?.test_checklist) ? raw.test_checklist : [], 10),
    questions_for_author: trimList(Array.isArray(raw?.questions_for_author) ? raw.questions_for_author : [], 8),
  };
  return packet;
};

try {
  if (!$env.GITHUB_TOKEN) {
    throw new Error('Missing required env var GITHUB_TOKEN.');
  }
  if (!$env.OPENAI_API_KEY) {
    throw new Error('Missing required env var OPENAI_API_KEY.');
  }
  if (destinationMode === 'slack' && !$env.SLACK_WEBHOOK_URL) {
    throw new Error('DESTINATION_MODE is slack but SLACK_WEBHOOK_URL is not set.');
  }
  if (destinationMode !== 'slack' && !$env.DISCORD_WEBHOOK_URL) {
    throw new Error('DESTINATION_MODE is discord (default) but DISCORD_WEBHOOK_URL is not set.');
  }
  if (!input.owner || !input.repo || !input.pr_number) {
    throw new Error('Normalized input is missing owner, repo, or pr_number.');
  }

  prIdentifier = `${input.owner}/${input.repo}#${input.pr_number}`;

  const githubHeaders = {
    Authorization: `Bearer ${$env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'n8n-pr-review-packet-bot',
  };

  const timeoutMs = Math.max(1000, Number($env.HTTP_TIMEOUT_MS || 30000));
  const pr = await requestWithRetry(
    {
      method: 'GET',
      url: `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.pr_number}`,
      headers: githubHeaders,
      json: true,
      timeout: timeoutMs,
    },
    'Get pull request metadata'
  );

  commitSha = pr?.head?.sha || input.reviewed_sha || 'unknown';
  const dedupeKey = `${input.owner}/${input.repo}#${input.pr_number}`;
  const previouslyReviewedSha = staticData.lastReviewedByPr[dedupeKey] || '';
  if (previouslyReviewedSha && commitSha !== 'unknown' && previouslyReviewedSha === commitSha) {
    const auditEntry = pushAudit('duplicate_skip', '', 'Same commit SHA already reviewed; notification skipped.');
    return [
      {
        json: {
          skipped: true,
          reason: 'Duplicate commit SHA detected; notification skipped to avoid spam.',
          pr_identifier: prIdentifier,
          commit_sha: commitSha,
          audit_entry: auditEntry,
        },
      },
    ];
  }

  const maxPages = Math.max(1, Number($env.MAX_FILE_PAGES || 10));
  const files = [];
  for (let page = 1; page <= maxPages; page++) {
    const pageFiles = await requestWithRetry(
      {
        method: 'GET',
        url: `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.pr_number}/files?per_page=100&page=${page}`,
        headers: githubHeaders,
        json: true,
        timeout: timeoutMs,
      },
      `List pull request files (page ${page})`
    );

    if (!Array.isArray(pageFiles)) {
      throw new Error(`Unexpected GitHub files response on page ${page}; expected array.`);
    }

    files.push(...pageFiles);
    if (pageFiles.length < 100) break;
  }

  staticData.lastReviewedByPr[dedupeKey] = commitSha;

  const maxPatchFiles = Math.max(1, Number($env.MAX_PATCH_FILES || 20));
  const maxPatchChars = Math.max(1000, Number($env.MAX_PATCH_CHARS || 12000));
  const sortedFiles = [...files].sort((a, b) => (Number(b.changes || 0) - Number(a.changes || 0)));

  let includedChars = 0;
  const selectedDiffs = [];
  const missingPatchFiles = [];
  const truncatedPatchFiles = [];

  for (const file of sortedFiles) {
    if (selectedDiffs.length >= maxPatchFiles) break;

    const patch = typeof file.patch === 'string' ? file.patch : '';
    const baseInfo = {
      filename: file.filename || 'unknown',
      status: file.status || 'modified',
      additions: Number(file.additions || 0),
      deletions: Number(file.deletions || 0),
      changes: Number(file.changes || 0),
    };

    if (!patch) {
      missingPatchFiles.push(baseInfo.filename);
      selectedDiffs.push({
        ...baseInfo,
        patch: '',
        patch_coverage: 'missing',
      });
      continue;
    }

    if (includedChars >= maxPatchChars) {
      truncatedPatchFiles.push(baseInfo.filename);
      continue;
    }

    const remaining = maxPatchChars - includedChars;
    let patchExcerpt = patch;
    let coverage = 'full';

    if (patch.length > remaining) {
      patchExcerpt = patch.slice(0, remaining);
      coverage = 'truncated';
      truncatedPatchFiles.push(baseInfo.filename);
    }

    includedChars += patchExcerpt.length;
    selectedDiffs.push({
      ...baseInfo,
      patch: patchExcerpt,
      patch_coverage: coverage,
    });
  }

  const allFilesMetadata = files.map((file) => ({
    filename: file.filename || 'unknown',
    status: file.status || 'modified',
    additions: Number(file.additions || 0),
    deletions: Number(file.deletions || 0),
    changes: Number(file.changes || 0),
    patch_available: typeof file.patch === 'string' && file.patch.length > 0,
  }));

  const linkedIssues = [];
  if (typeof pr.body === 'string') {
    const issueRegex = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
    let match;
    while ((match = issueRegex.exec(pr.body)) !== null) {
      const issueRef = `#${match[1]}`;
      if (!linkedIssues.includes(issueRef)) linkedIssues.push(issueRef);
    }
  }

  const secretRegex = /(AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----|api[_-]?key\s*[:=]\s*['"][^'"]{8,}|secret\s*[:=]\s*['"][^'"]{8,}|password\s*[:=]\s*['"][^'"]{6,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,})/i;
  const suspectedSecretExposure = files.some((file) => typeof file.patch === 'string' && secretRegex.test(file.patch));

  const reviewContext = {
    pr: {
      title: pr.title || '',
      body: pr.body || '',
      author: pr.user?.login || '',
      base_branch: pr.base?.ref || '',
      head_branch: pr.head?.ref || '',
      url: pr.html_url || input.pr_url || '',
      number: Number(pr.number || input.pr_number || 0),
      labels: Array.isArray(pr.labels) ? pr.labels.map((l) => l.name).filter(Boolean) : [],
      requested_reviewers: Array.isArray(pr.requested_reviewers)
        ? pr.requested_reviewers.map((r) => r.login).filter(Boolean)
        : [],
      linked_issues: linkedIssues,
    },
    files: {
      total_files: files.length,
      all_files_metadata: allFilesMetadata,
      selected_diffs: selectedDiffs,
      selection_limits: {
        max_patch_files: maxPatchFiles,
        max_patch_chars: maxPatchChars,
        included_patch_chars: includedChars,
      },
      missing_patch_files: missingPatchFiles,
      truncated_patch_files: truncatedPatchFiles,
    },
    limitations: {
      missing_patch_count: missingPatchFiles.length,
      truncated_patch_count: truncatedPatchFiles.length,
      patch_coverage_limited: missingPatchFiles.length > 0 || truncatedPatchFiles.length > 0,
    },
    security_signals: {
      suspected_secret_exposure: suspectedSecretExposure,
    },
  };

  const systemPrompt = [
    'You are a senior engineer producing a PR Review Packet.',
    'Use ONLY the provided PR metadata and diffs. Never invent file contents, APIs, tests, or dependencies.',
    'If diffs are missing/truncated, explicitly state reduced confidence in risk_reasoning and/or questions_for_author.',
    'Output strict JSON with exactly these keys and no extras:',
    'summary, risk, risk_reasoning, key_changes, files_of_interest, suggested_review_comments, test_checklist, questions_for_author.',
    'risk must be one of: low, medium, high.',
    'Array items must be concise and actionable.',
    'Prioritize correctness, edge cases, failure modes, security, performance, migrations/config changes, and test gaps.',
    'If secrets/tokens/private keys are suspected, set risk to high and recommend remediation (remove secret, rotate key, purge history as needed).',
  ].join('\n');

  const openAiResponse = await requestWithRetry(
    {
      method: 'POST',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        Authorization: `Bearer ${$env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: {
        model: $env.OPENAI_MODEL || 'gpt-4.1-mini',
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `PR context JSON:\n${JSON.stringify(reviewContext)}` },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'pr_review_packet',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: [
                'summary',
                'risk',
                'risk_reasoning',
                'key_changes',
                'files_of_interest',
                'suggested_review_comments',
                'test_checklist',
                'questions_for_author',
              ],
              properties: {
                summary: { type: 'string' },
                risk: { type: 'string', enum: ['low', 'medium', 'high'] },
                risk_reasoning: { type: 'array', items: { type: 'string' } },
                key_changes: { type: 'array', items: { type: 'string' } },
                files_of_interest: { type: 'array', items: { type: 'string' } },
                suggested_review_comments: { type: 'array', items: { type: 'string' } },
                test_checklist: { type: 'array', items: { type: 'string' } },
                questions_for_author: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      json: true,
      timeout: Math.max(1000, Number($env.OPENAI_TIMEOUT_MS || 60000)),
    },
    'Generate PR review packet'
  );

  const modelContent = openAiResponse?.choices?.[0]?.message?.content;
  let parsedPacket;
  if (typeof modelContent === 'string') {
    parsedPacket = JSON.parse(modelContent);
  } else if (modelContent && typeof modelContent === 'object') {
    parsedPacket = modelContent;
  } else {
    throw new Error('OpenAI response did not contain parseable JSON content.');
  }

  const packet = buildPacket(parsedPacket);

  if (reviewContext.limitations.patch_coverage_limited) {
    if (packet.risk === 'low') packet.risk = 'medium';
    addUnique(packet.risk_reasoning, `Review confidence is limited: ${reviewContext.limitations.missing_patch_count} files have missing patches and ${reviewContext.limitations.truncated_patch_count} patches were truncated.`);
    addUnique(packet.questions_for_author, 'Can you share full diffs for files with missing/truncated patches to complete the review?');
  }

  if (suspectedSecretExposure) {
    packet.risk = 'high';
    addUnique(packet.risk_reasoning, 'Potential secret/token/private key exposure detected in diff content.');
    addUnique(packet.suggested_review_comments, 'Remove any exposed secret from code and configuration immediately.');
    addUnique(packet.suggested_review_comments, 'Rotate the exposed credential and purge it from git history if it was committed.');
  }

  if (packet.risk === 'high') {
    addUnique(packet.suggested_review_comments, 'Require explicit human reviewer sign-off before merge.');
    addUnique(packet.test_checklist, 'Verify rollback plan and rollback command/runbook before deployment.');
    addUnique(packet.test_checklist, 'Run targeted regression tests on impacted paths and security boundaries.');
  }

  packet.risk_reasoning = trimList(packet.risk_reasoning, 8);
  packet.key_changes = trimList(packet.key_changes, 8);
  packet.files_of_interest = trimList(packet.files_of_interest, 12);
  packet.suggested_review_comments = trimList(packet.suggested_review_comments, 10);
  packet.test_checklist = trimList(packet.test_checklist, 10);
  packet.questions_for_author = trimList(packet.questions_for_author, 8);

  const bullet = (items) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- None.');
  let message = [
    `PR Review Packet for ${prIdentifier}`,
    '',
    '1) Summary',
    packet.summary,
    '',
    '2) Risk + reasoning',
    `Risk: ${packet.risk.toUpperCase()}`,
    bullet(packet.risk_reasoning),
    '',
    '3) Key changes',
    bullet(packet.key_changes),
    '',
    '4) Files of interest',
    bullet(packet.files_of_interest),
    '',
    '5) Suggested review comments',
    bullet(packet.suggested_review_comments),
    '',
    '6) Test checklist',
    bullet(packet.test_checklist),
    '',
    '7) Questions for author',
    bullet(packet.questions_for_author),
  ].join('\n');

  if (packet.risk === 'high') {
    message += '\n\nHigh-Risk Guidance:\n- Human review is strongly required before merge.\n- Validate rollback/testing steps before deployment.\n- Do not approve/ship based only on this automated packet.';
  }

  if (destinationMode === 'discord' && message.length > 1900) {
    message = `${message.slice(0, 1850)}\n\n- Message truncated due to Discord length limits.`;
  }

  let postResponse = {};
  let messageLink = '';
  if (destinationMode === 'slack') {
    postResponse = await requestWithRetry(
      {
        method: 'POST',
        url: $env.SLACK_WEBHOOK_URL,
        headers: { 'Content-Type': 'application/json' },
        body: { text: message },
        json: true,
        timeout: timeoutMs,
      },
      'Post Slack summary'
    );
  } else {
    const baseUrl = $env.DISCORD_WEBHOOK_URL;
    const discordUrl = baseUrl.includes('?') ? `${baseUrl}&wait=true` : `${baseUrl}?wait=true`;
    postResponse = await requestWithRetry(
      {
        method: 'POST',
        url: discordUrl,
        headers: { 'Content-Type': 'application/json' },
        body: { content: message },
        json: true,
        timeout: timeoutMs,
      },
      'Post Discord summary'
    );

    if (postResponse?.id && postResponse?.channel_id && postResponse?.guild_id) {
      messageLink = `https://discord.com/channels/${postResponse.guild_id}/${postResponse.channel_id}/${postResponse.id}`;
    }
  }

  const auditEntry = pushAudit(packet.risk, messageLink);

  return [
    {
      json: {
        reviewed_at: nowIso,
        trigger_mode: input.trigger_mode,
        pr_identifier: prIdentifier,
        commit_sha: commitSha,
        review_packet: packet,
        formatted_message: message,
        destination: destinationMode,
        message_link: messageLink,
        audit_entry: auditEntry,
        limitations: reviewContext.limitations,
      },
    },
  ];
} catch (error) {
  const errorEntry = pushAudit('error', '', error.message);
  throw new Error(`PR review packet workflow failed for ${prIdentifier}: ${error.message}. Check credentials, rate limits, and webhook payload.`);
}
'@

$skipLogCode = @'
const item = $input.first().json;
const staticData = $getWorkflowStaticData('global');
if (!Array.isArray(staticData.auditLog)) {
  staticData.auditLog = [];
}

const entry = {
  timestamp: new Date().toISOString(),
  pr_identifier: item.pr_identifier || 'unknown',
  commit_sha: item.reviewed_sha || 'unknown',
  risk_level: 'ignored_event',
  message_link: '',
  note: item.skip_reason || 'Event ignored before review.',
};

staticData.auditLog.unshift(entry);
staticData.auditLog = staticData.auditLog.slice(0, 500);

return [
  {
    json: {
      skipped: true,
      reason: item.skip_reason || 'Event ignored.',
      audit_entry: entry,
    },
  },
];
'@

$workflow = @{
  name = 'PR Summarizer + Auto-Reviewer Bot'
  nodes = @(
    @{
      id = 'node-webhook-auto'
      name = 'Webhook Auto'
      type = 'n8n-nodes-base.webhook'
      typeVersion = 2.1
      position = @(-860, -220)
      parameters = @{
        httpMethod = 'POST'
        path = 'github-pr-review-auto'
        responseMode = 'onReceived'
        options = @{}
      }
      onError = 'continueRegularOutput'
    },
    @{
      id = 'node-webhook-manual'
      name = 'Webhook Manual'
      type = 'n8n-nodes-base.webhook'
      typeVersion = 2.1
      position = @(-860, 20)
      parameters = @{
        httpMethod = 'POST'
        path = 'github-pr-review-manual'
        responseMode = 'onReceived'
        options = @{}
      }
      onError = 'continueRegularOutput'
    },
    @{
      id = 'node-normalize-input'
      name = 'Normalize Input'
      type = 'n8n-nodes-base.code'
      typeVersion = 2
      position = @(-580, -100)
      parameters = @{
        language = 'javaScript'
        mode = 'runOnceForAllItems'
        jsCode = $normalizeCode
      }
    },
    @{
      id = 'node-should-process'
      name = 'Should Process Event'
      type = 'n8n-nodes-base.if'
      typeVersion = 2.3
      position = @(-300, -100)
      parameters = @{
        conditions = @{
          options = @{
            version = 2
            leftValue = ''
            caseSensitive = $true
            typeValidation = 'strict'
          }
          combinator = 'and'
          conditions = @(
            @{
              id = 'condition-process-event'
              operator = @{
                type = 'boolean'
                operation = 'true'
                singleValue = $true
              }
              leftValue = '={{ !$json.skip }}'
              rightValue = ''
            }
          )
        }
        options = @{}
      }
    },
    @{
      id = 'node-review-and-notify'
      name = 'PR Review + Notify'
      type = 'n8n-nodes-base.code'
      typeVersion = 2
      position = @(-20, -220)
      retryOnFail = $true
      maxTries = 2
      waitBetweenTries = 2000
      parameters = @{
        language = 'javaScript'
        mode = 'runOnceForAllItems'
        jsCode = $reviewCode
      }
    },
    @{
      id = 'node-log-skipped'
      name = 'Log Skipped Event'
      type = 'n8n-nodes-base.code'
      typeVersion = 2
      position = @(-20, 20)
      parameters = @{
        language = 'javaScript'
        mode = 'runOnceForAllItems'
        jsCode = $skipLogCode
      }
    }
  )
  connections = @{
    'Webhook Auto' = @{
      main = @(,
        @(
          @{
            node = 'Normalize Input'
            type = 'main'
            index = 0
          }
        )
      )
    }
    'Webhook Manual' = @{
      main = @(,
        @(
          @{
            node = 'Normalize Input'
            type = 'main'
            index = 0
          }
        )
      )
    }
    'Normalize Input' = @{
      main = @(,
        @(
          @{
            node = 'Should Process Event'
            type = 'main'
            index = 0
          }
        )
      )
    }
    'Should Process Event' = @{
      main = @(
        @(
          @{
            node = 'PR Review + Notify'
            type = 'main'
            index = 0
          }
        ),
        @(
          @{
            node = 'Log Skipped Event'
            type = 'main'
            index = 0
          }
        )
      )
    }
  }
  settings = @{
    executionOrder = 'v1'
    saveDataErrorExecution = 'all'
    saveDataSuccessExecution = 'all'
    saveExecutionProgress = $true
  }
  active = $false
  meta = @{
    templateCredsSetupCompleted = $false
  }
}

$outputPath = Join-Path $PSScriptRoot '..\pr-review-packet-workflow.json'
$workflow | ConvertTo-Json -Depth 100 | Set-Content -Path $outputPath -Encoding UTF8
Write-Output "Workflow export written to: $outputPath"

