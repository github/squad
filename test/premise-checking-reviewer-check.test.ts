import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_ID,
  REVIEWER_CHECK_DIRECTIVE,
  summarizeDispatch,
  validateReviewerAccountingRecord,
} from '../scripts/premise-checking-ab.mjs';

const MODEL = 'claude-sonnet-5.5';

function reviewedRun() {
  const record = {
    status: 'completed',
    arm: 'reviewer-accounting-check',
    factCheckerSessionIds: ['reviewer-1'],
    messages: [
      { sessionId: 'coordinator-1', role: 'coordinator', content: 'Answer.' },
      { sessionId: 'reviewer-1', role: 'fact-checker', content: 'Review complete.' },
    ],
    usageEvents: [
      { sessionId: 'coordinator-1', role: 'coordinator', usageStatus: 'observed', inputTokens: 100, outputTokens: 10, model: MODEL },
      { sessionId: 'reviewer-1', role: 'fact-checker', usageStatus: 'observed', inputTokens: 40, outputTokens: 6, model: MODEL },
    ],
  };
  const events = [
    { eventType: 'tool.execution_start', sessionId: 'coordinator-1', role: 'coordinator', data: { toolName: 'task', toolCallId: 'task-1', arguments: { evidence_ids: ['market-report'] } } },
    { eventType: 'tool.execution_start', sessionId: 'reviewer-1', role: 'fact-checker', data: { toolName: 'read_evidence', toolCallId: 'read-1', arguments: { id: 'market-report' } } },
    { eventType: 'evidence.read', sessionId: 'reviewer-1', role: 'fact-checker', id: 'market-report' },
    { eventType: 'tool.execution_complete', sessionId: 'reviewer-1', role: 'fact-checker', data: { toolName: 'read_evidence', toolCallId: 'read-1' } },
    { eventType: 'fact-checker.review_completed', coordinatorSessionId: 'coordinator-1', taskCallId: 'task-1', reviewerSessionId: 'reviewer-1', evidenceIds: ['market-report'], reviewLength: 16 },
    { eventType: 'tool.execution_complete', sessionId: 'coordinator-1', role: 'coordinator', data: { toolName: 'task', toolCallId: 'task-1' } },
  ];
  return { record, events };
}

describe('scripted reviewer accounting check', () => {
  it('keeps the Copilot model as the default', () => {
    expect(DEFAULT_MODEL_ID).toBe('gpt-5.3-codex');
  });

  it('tells the coordinator to dispatch exactly once with every evidence ID', () => {
    expect(REVIEWER_CHECK_DIRECTIVE).toMatch(/exactly once/);
    expect(REVIEWER_CHECK_DIRECTIVE).toMatch(/evidence_ids/);
  });

  it('passes a run with one traced, accounted Fact Checker review', () => {
    const { record, events } = reviewedRun();
    const result = validateReviewerAccountingRecord(record, events, MODEL);
    expect(result).toMatchObject({ passed: true, issues: [], reviewerCalls: 1, reviewerInputTokens: 40, reviewerOutputTokens: 6 });
  });

  it('fails when the coordinator never dispatches', () => {
    const { record, events } = reviewedRun();
    const result = validateReviewerAccountingRecord(
      { ...record, factCheckerSessionIds: [], usageEvents: [record.usageEvents[0]] },
      events.filter(event => event.sessionId === 'coordinator-1' && event.data?.toolName !== 'task'),
      MODEL,
    );
    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining(['fact-checker-dispatches:0', 'fact-checker-usage-not-observed']));
  });

  it('fails when reviewer usage is missing or the model drifts', () => {
    const { record, events } = reviewedRun();
    const unknown = { ...record, usageEvents: [record.usageEvents[0], { ...record.usageEvents[1], usageStatus: 'unknown', inputTokens: null }] };
    expect(validateReviewerAccountingRecord(unknown, events, MODEL).issues).toContain('usage-accounting-incomplete');
    expect(validateReviewerAccountingRecord(record, events, 'gpt-5.3-codex').issues).toContain('model-drift-observed');
  });

  it('fails when the review is not backed by an evidence read', () => {
    const { record, events } = reviewedRun();
    const result = validateReviewerAccountingRecord(record, events.filter(event => event.eventType !== 'evidence.read'), MODEL);
    expect(result.issues).toContain('fact-checker-evidence-review-trace-incomplete');
  });
});

describe('Fact Checker dispatch measurement', () => {
  it('counts dispatching trajectories per arm', () => {
    expect(summarizeDispatch([
      { arm: 'baseline', factCheckerSessionIds: [] },
      { arm: 'truth-first', factCheckerSessionIds: ['r1'] },
      { arm: 'truth-first', factCheckerSessionIds: [] },
    ])).toEqual({
      baseline: { trajectories: 1, dispatched: 0 },
      'truth-first': { trajectories: 2, dispatched: 1 },
    });
  });
});
