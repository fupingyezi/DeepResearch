import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Terminal } from 'lucide-react';
import CopyButton from './copy-button';

const CustomMarkdown: React.FC<{ content: string }> = ({ content }) => {
  return (
    <div className="prose prose-zinc dark:prose-invert max-w-none">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code({
            node,
            inline,
            className,
            children,
            ...props
          }: {
            node?: any;
            inline?: boolean;
            className?: string;
            children?: React.ReactNode;
          }) {
            const match = /language-(\w+)/.exec(className || '');

            if (!inline && match?.length) {
              const id = Math.random().toString(36).substring(2, 9);
              const language = match[1];

              const extractText = (child: any): string => {
                if (typeof child === 'string') return child;
                if (typeof child === 'number') return String(child);
                if (child?.props?.children) {
                  if (Array.isArray(child.props.children)) {
                    return child.props.children.map(extractText).join('');
                  }
                  return extractText(child.props.children);
                }
                return '';
              };

              const codeString = Array.isArray(children)
                ? children.map(extractText).join('')
                : extractText(children);

              return (
                <div className="not-prose my-4 rounded-md border border-zinc-200 dark:border-zinc-700">
                  <div className="flex h-12 items-center justify-between bg-zinc-100 px-4 dark:bg-zinc-900">
                    <div className="flex items-center gap-2">
                      <Terminal size={18} />
                      <p className="text-sm text-zinc-600 dark:text-zinc-400">{language}</p>
                    </div>
                    <CopyButton id={id} />
                  </div>
                  <div className="overflow-x-auto">
                    <SyntaxHighlighter
                      style={vs}
                      language={language}
                      PreTag="div"
                      customStyle={{
                        margin: 0,
                        padding: '1rem',
                        background: 'transparent',
                      }}
                      wrapLongLines={true}
                    >
                      {codeString.replace(/\n$/, '')}
                    </SyntaxHighlighter>
                    <div id={id} style={{ display: 'none' }}>
                      {codeString}
                    </div>
                  </div>
                </div>
              );
            } else {
              return (
                <code
                  {...props}
                  className="not-prose rounded bg-gray-100 px-1 py-0.5 text-sm dark:bg-zinc-800"
                >
                  {children}
                </code>
              );
            }
          },
          img({ src, alt, ...props }) {
            const publicPath = process.env.PUBLIC_URL || '';
            const imgSrc = src?.startsWith('http') ? src : `${publicPath}${src}`;
            return (
              <img src={imgSrc} alt={alt} className="h-auto max-w-full rounded-lg" {...props} />
            );
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
};

export default CustomMarkdown;
