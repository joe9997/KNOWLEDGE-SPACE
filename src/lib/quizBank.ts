import { findQuote, normalizeQuoteText } from './quotes';
import type { KnowledgeDoc, KnowledgeNode } from './types';

export type QuizMode = 'choice' | 'self';

export interface ChoiceQuestion {
  nodeId: string;
  prompt: string;
  options: Array<{ id: string; text: string }>;
  correctOptionId: string;
}

interface SourceText {
  node: KnowledgeNode;
  text: string;
  normalized: string;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function buildChoiceQuestions(
  doc: KnowledgeDoc,
  nodeIds: string[],
  random = Math.random,
): ChoiceQuestion[] {
  const sources: SourceText[] = [];
  for (const node of doc.nodes) {
    const match = findQuote(doc.text, node.quote);
    if (!match.matched) {
      continue;
    }
    const text = doc.text.slice(match.start, match.end);
    sources.push({ node, text, normalized: normalizeQuoteText(text).text });
  }

  if (new Set(sources.map((source) => source.normalized)).size < 2) {
    return [];
  }

  const sourceById = new Map(sources.map((source) => [source.node.id, source]));
  const seen = new Set<string>();
  const questions: ChoiceQuestion[] = [];

  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) {
      continue;
    }
    seen.add(nodeId);

    const answer = sourceById.get(nodeId);
    if (!answer) {
      continue;
    }

    const candidates = sources.filter(
      (source) => source.node.id !== nodeId && source.normalized !== answer.normalized,
    );
    const sameParent = candidates.filter(
      (source) => source.node.parentId === answer.node.parentId,
    );
    const sameLevel = candidates.filter(
      (source) =>
        source.node.parentId !== answer.node.parentId && source.node.level === answer.node.level,
    );
    const remaining = candidates.filter(
      (source) =>
        source.node.parentId !== answer.node.parentId && source.node.level !== answer.node.level,
    );

    const options = [{ id: answer.node.id, text: answer.text }];
    const optionTexts = new Set([answer.normalized]);
    for (const candidate of [...sameParent, ...sameLevel, ...remaining]) {
      if (optionTexts.has(candidate.normalized)) {
        continue;
      }
      optionTexts.add(candidate.normalized);
      options.push({ id: candidate.node.id, text: candidate.text });
      if (options.length === 4) {
        break;
      }
    }

    if (options.length < 2) {
      continue;
    }
    questions.push({
      nodeId,
      prompt: answer.node.question || `请复述「${answer.node.title}」的要点。`,
      options: shuffle(options, random),
      correctOptionId: answer.node.id,
    });
  }

  return questions;
}