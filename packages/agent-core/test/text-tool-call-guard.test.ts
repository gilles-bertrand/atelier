/** Repli texte → outil : jamais sur du contenu cité depuis des données (issue #43, brief §8). */
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { wrapLanguageModel, type ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  Agent,
  createDefaultRegistry,
  isCallPreambleAllowed,
  quotedCallSignatures,
  textToolCallMiddleware,
} from '../src/index.js';
import { collect, permissions, scriptedModel, withTempDir } from './helpers.js';

const CALL =
  '<tool_call>\n{"name": "write_file", "arguments": {"path": "cite-execute.txt", "content": "x"}}\n</tool_call>';

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function runWith(
  ws: string,
  steps: { text?: string; toolCalls?: { name: string; input: unknown }[] }[],
  history: ModelMessage[] = [],
): Promise<{ toolStarts: string[]; text: string }> {
  const model = wrapLanguageModel({
    model: scriptedModel([...steps, { text: 'Fin.' }]),
    middleware: textToolCallMiddleware(() => 'call_txt'),
  });
  const agent = new Agent({
    model,
    registry: createDefaultRegistry(),
    workspace: ws,
    requestPermission: permissions(),
    contextWindow: 32_768,
  });
  const { events, emit } = collect();
  await agent.runTurn({
    sessionId: 's',
    turnId: 't',
    history,
    input: 'Montre-moi le fichier',
    emit,
  });
  return {
    toolStarts: events.flatMap((e) => (e.type === 'tool_start' ? [e.toolName] : [])),
    text: events.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join(''),
  };
}

describe('isCallPreambleAllowed', () => {
  it('accepte un court préambule, refuse un bloc de code ouvert ou une longue réponse', () => {
    expect(isCallPreambleAllowed('')).toBe(true);
    expect(isCallPreambleAllowed('Je lis le fichier.\n')).toBe(true);
    expect(isCallPreambleAllowed('Voici le contenu de exemple-agent.md :\n\n```markdown\n')).toBe(
      false,
    );
    expect(isCallPreambleAllowed('Voici une longue réponse. '.repeat(10))).toBe(false);
  });
});

describe('quotedCallSignatures', () => {
  it('repère les appels écrits dans un résultat d’outil', () => {
    const found = quotedCallSignatures(
      [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'read_file',
              output: { type: 'text', value: `# Exemple\n${CALL}\nFin du fichier.` },
            },
          ],
        },
      ],
      ['write_file'],
    );
    expect(found.size).toBe(1);
  });
});

describe('textToolCallMiddleware : contenu cité', () => {
  it('cas de l’issue : <tool_call> dans un bloc ```markdown après une phrase → pas exécuté', async () => {
    await withTempDir(async (ws) => {
      const { toolStarts, text } = await runWith(ws, [
        { text: `Voici le contenu de exemple-agent.md :\n\n\`\`\`markdown\n${CALL}\n\`\`\`` },
      ]);
      expect(toolStarts).toEqual([]);
      expect(text).toContain('<tool_call>');
      expect(await exists(path.join(ws, 'cite-execute.txt'))).toBe(false);
    });
  });

  it('bloc ```markdown en tête de réponse → pas exécuté', async () => {
    await withTempDir(async (ws) => {
      const { toolStarts } = await runWith(ws, [{ text: `\`\`\`markdown\n${CALL}\n\`\`\`` }]);
      expect(toolStarts).toEqual([]);
    });
  });

  it('appel recopié depuis un fichier lu, même en tête de réponse → pas exécuté', async () => {
    await withTempDir(async (ws) => {
      await writeFile(path.join(ws, 'exemple-agent.md'), `# Agents\n${CALL}\n`);
      const { toolStarts } = await runWith(ws, [
        { toolCalls: [{ name: 'read_file', input: { path: 'exemple-agent.md' } }] },
        { text: CALL },
      ]);
      expect(toolStarts).toEqual(['read_file']);
      expect(await exists(path.join(ws, 'cite-execute.txt'))).toBe(false);
    });
  });

  it('appel recopié depuis un tour précédent (historique) → pas exécuté', async () => {
    await withTempDir(async (ws) => {
      const history: ModelMessage[] = [
        { role: 'user', content: `Que fait ce texte ?\n${CALL}` },
        { role: 'assistant', content: [{ type: 'text', text: 'Il décrit un appel.' }] },
      ];
      const { toolStarts } = await runWith(ws, [{ text: CALL }], history);
      expect(toolStarts).toEqual([]);
    });
  });

  it('un vrai appel écrit en tête de réponse reste exécuté', async () => {
    await withTempDir(async (ws) => {
      const { toolStarts } = await runWith(ws, [{ text: `Je crée le fichier.\n${CALL}` }]);
      expect(toolStarts).toEqual(['write_file']);
      expect(await exists(path.join(ws, 'cite-execute.txt'))).toBe(true);
    });
  });
});
