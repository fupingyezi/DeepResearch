import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Terminal } from 'lucide-react';
import CopyButton from './copy-button';

const CustomMarkdown: React.FC<{ content: string }> = ({ content }) => {
  return (
    <div className="prose prose-zinc prose-headings:scroll-mt-4 prose-headings:font-semibold prose-headings:text-gray-900 prose-h1:text-[26px] prose-h1:leading-snug prose-h1:mb-4 prose-h2:text-[20px] prose-h2:mt-8 prose-h2:mb-3 prose-h2:border-b prose-h2:border-gray-100 prose-h2:pb-2 prose-h3:text-[17px] prose-p:text-[15px] prose-p:leading-7 prose-p:text-gray-700 prose-a:text-teal-600 prose-a:no-underline hover:prose-a:underline prose-strong:text-gray-900 prose-li:text-[15px] prose-li:text-gray-700 prose-blockquote:border-l-teal-400 prose-blockquote:bg-teal-50/40 prose-blockquote:py-1 prose-blockquote:text-gray-600 prose-blockquote:not-italic prose-table:text-sm prose-th:bg-gray-50 prose-img:rounded-xl prose-img:shadow-sm max-w-none min-w-0 wrap-break-word">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          // 覆盖 pre：去掉 prose 默认给 <pre> 注入的深底/padding/圆角，
          // 因为我们的代码块卡片由下方 code 组件自己渲染（带头部 + 浅色容器）。
          // 不写 not-prose 是为了保留 children 内部继续被 markdown 处理。
          pre({ children, ...props }: { children?: React.ReactNode }) {
            return (
              <div {...props} className="not-prose my-0 bg-transparent p-0">
                {children}
              </div>
            );
          },
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

            // 把 children 拍平成纯文本（用于无语言代码块直接渲染 + 复制按钮）
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

            // 块级代码（fenced code block）：无论是否带语言，都走同款深色容器。
            // react-markdown v10 不再传 `inline`，靠 className 判定：含 language- 的一定是块；
            // 否则用换行符是否存在来判定（fenced block 必含 \n）。
            const isBlock = inline === false || !!match || /\n/.test(codeString);

            if (isBlock) {
              const id = Math.random().toString(36).substring(2, 9);
              const language = match?.[1] ?? 'text';
              const hasHighlighter = !!match;

              return (
                <div className="not-prose my-4 w-full min-w-0 overflow-hidden rounded-xl border border-zinc-200 bg-[#f6f8fa]">
                  <div className="flex h-11 items-center justify-between border-b border-zinc-200 bg-white px-4">
                    <div className="flex items-center gap-2">
                      <Terminal size={14} className="text-zinc-500" />
                      <p className="text-xs font-medium text-zinc-600">{language}</p>
                    </div>
                    <CopyButton id={id} />
                  </div>
                  <div className="scrollbar-slim overflow-x-auto">
                    {hasHighlighter ? (
                      <SyntaxHighlighter
                        style={oneLight}
                        language={language}
                        PreTag="div"
                        customStyle={{
                          margin: 0,
                          padding: '1rem',
                          background: '#f6f8fa',
                          fontSize: '13px',
                          whiteSpace: 'pre',
                          wordBreak: 'normal',
                          overflowWrap: 'normal',
                        }}
                        codeTagProps={{
                          style: {
                            fontFamily:
                              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                            background: 'transparent',
                            textShadow: 'none',
                            whiteSpace: 'pre',
                          },
                        }}
                      >
                        {codeString.replace(/\n$/, '')}
                      </SyntaxHighlighter>
                    ) : (
                      // 无语言：纯 pre，避免 SyntaxHighlighter 把 ASCII 树状图按词法误染
                      <pre
                        className="m-0 p-4 text-[13px] leading-relaxed text-zinc-800"
                        style={{
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                          whiteSpace: 'pre',
                          wordBreak: 'normal',
                          overflowWrap: 'normal',
                          background: 'transparent',
                        }}
                      >
                        <code style={{ background: 'transparent' }}>
                          {codeString.replace(/\n$/, '')}
                        </code>
                      </pre>
                    )}
                    <div id={id} style={{ display: 'none' }}>
                      {codeString}
                    </div>
                  </div>
                </div>
              );
            }

            // 行内代码：保持浅色徽章风格
            return (
              <code
                {...props}
                className="not-prose rounded bg-teal-50 px-1.5 py-0.5 text-[13px] wrap-break-word text-teal-700"
              >
                {children}
              </code>
            );
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
