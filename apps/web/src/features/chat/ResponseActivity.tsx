import type { MessageSource, ToolActivity } from '@walden/contracts';
import { CircleDashedIcon, XCircleIcon } from 'lucide-react';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '../../components/ai-elements/chain-of-thought';
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from '../../components/ai-elements/sources';
import { toolLabel } from '../../components/ai-elements/tool';

function safeSource(source: MessageSource): (MessageSource & { domain: string }) | null {
  try {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return { ...source, url: url.toString(), domain: url.hostname.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

export function ResponseActivity({
  tools = [],
  live = false,
}: {
  tools?: ToolActivity[];
  live?: boolean;
}) {
  if (!tools.length) return null;

  // While the turn is still running this panel is the only progress the reader
  // gets, so it starts open. Collapsed, a multi-second tool call looks like the
  // app has stalled and then answered all at once. Finished turns stay folded
  // away, since by then the answer is what matters.
  return (
    <ChainOfThought className="mt-1" aria-label="Response activity" defaultOpen={live}>
      <ChainOfThoughtHeader>Activity</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {tools.map((tool) => (
          <ChainOfThoughtStep
            key={tool.id}
            // A running step is the only thing on screen during a multi-second
            // tool call, and a static icon there reads as a stall.
            className={tool.state === 'running' ? 'activity-step-running' : ''}
            label={
              <>
                {toolLabel(tool.name)}
                <span className="sr-only">
                  {' '}
                  {tool.state === 'running'
                    ? 'Running'
                    : tool.state === 'error'
                      ? 'Failed'
                      : 'Completed'}
                </span>
              </>
            }
            description={tool.summary}
            status={tool.state === 'running' ? 'active' : 'complete'}
            icon={
              tool.state === 'running'
                ? CircleDashedIcon
                : tool.state === 'error'
                  ? XCircleIcon
                  : undefined
            }
          />
        ))}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

export function ResponseSources({ sources = [] }: { sources?: MessageSource[] }) {
  const uniqueSources = Array.from(
    sources.reduce((result, source) => {
      const safe = safeSource(source);
      if (safe && !result.has(safe.url)) result.set(safe.url, safe);
      return result;
    }, new Map<string, MessageSource & { domain: string }>()),
    ([, source]) => source,
  );
  if (!uniqueSources.length) return null;

  return (
    <Sources className="mt-2" aria-label="Response sources">
      <SourcesTrigger count={uniqueSources.length} />
      <SourcesContent>
        {uniqueSources.map((source) => (
          <Source key={source.url} href={source.url} title={source.title?.trim() || source.url}>
            {source.title?.trim() || source.domain}
          </Source>
        ))}
      </SourcesContent>
    </Sources>
  );
}
