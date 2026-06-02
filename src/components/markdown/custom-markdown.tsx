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
    <div className="prose prose-zinc prose-headings:scroll-mt-4 prose-headings:font-semibold prose-headings:text-gray-900 prose-h1:text-[26px] prose-h1:leading-snug prose-h1:mb-4 prose-h2:text-[20px] prose-h2:mt-8 prose-h2:mb-3 prose-h2:border-b prose-h2:border-gray-100 prose-h2:pb-2 prose-h3:text-[17px] prose-p:text-[15px] prose-p:leading-7 prose-p:text-gray-700 prose-a:text-teal-600 prose-a:no-underline hover:prose-a:underline prose-strong:text-gray-900 prose-li:text-[15px] prose-li:text-gray-700 prose-blockquote:border-l-teal-400 prose-blockquote:bg-teal-50/40 prose-blockquote:py-1 prose-blockquote:text-gray-600 prose-blockquote:not-italic prose-table:text-sm prose-th:bg-gray-50 prose-img:rounded-xl prose-img:shadow-sm max-w-none min-w-0 break-words">
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
                <div className="not-prose my-4 w-full min-w-0 overflow-hidden rounded-xl border border-zinc-200">
                  <div className="flex h-11 items-center justify-between bg-zinc-50 px-4">
                    <div className="flex items-center gap-2">
                      <Terminal size={16} className="text-teal-600" />
                      <p className="text-xs font-medium text-zinc-500">{language}</p>
                    </div>
                    <CopyButton id={id} />
                  </div>
                  <div className="scrollbar-slim overflow-x-auto">
                    <SyntaxHighlighter
                      style={vs}
                      language={language}
                      PreTag="div"
                      customStyle={{
                        margin: 0,
                        padding: '1rem',
                        background: 'transparent',
                        fontSize: '13px',
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
                  className="not-prose rounded bg-teal-50 px-1.5 py-0.5 text-[13px] break-words text-teal-700"
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
