import { Streamdown } from 'streamdown';
import { escapeCurrency, math } from './math';

export function MessageResponse({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={`message-response ${className}`}>
      <Streamdown skipHtml plugins={{ math }}>
        {escapeCurrency(children)}
      </Streamdown>
    </div>
  );
}
