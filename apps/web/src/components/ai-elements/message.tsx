import { Streamdown } from 'streamdown';

export function MessageResponse({
  children,
  className = '',
}: {
  children: string;
  className?: string;
}) {
  return (
    <div className={`message-response ${className}`}>
      <Streamdown skipHtml>{children}</Streamdown>
    </div>
  );
}
