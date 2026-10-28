import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeHttpUrl } from '@renderer/lib/tool-labels';

/**
 * Rendu markdown des réponses. Pas de HTML brut (react-markdown l'ignore), pas
 * d'image distante (la CSP les bloque : on affiche le texte alternatif), liens
 * http(s) seulement, ouverts dans le navigateur système.
 */
const components: Components = {
  a: ({ href, children }) => {
    const url = safeHttpUrl(href);
    if (!url) return <span>{children}</span>;
    return (
      <a href={url} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img: ({ alt }) => (alt ? <span className="text-muted-foreground">[image : {alt}]</span> : null),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
