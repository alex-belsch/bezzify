import { useEffect, useState } from 'react';
import { channelColor } from '../format';
import { useApp } from '../state';

export function CodeBlock({ code }: { code: string }) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // ohne HTTPS fehlt navigator.clipboard, der Browser kann auch die Berechtigung verweigern
      toast('Kopieren nicht möglich, bitte den Text markieren und selbst kopieren');
      return;
    }
    setCopied(true);
  };

  return (
    <div className="code">
      <button type="button" className="btn quiet small" onClick={copy}>
        {copied ? 'Kopiert' : 'Kopieren'}
      </button>
      {code}
    </div>
  );
}

export function ChannelKey({ channel, label }: { channel: string; label: string }) {
  return (
    <span className="key">
      <span className="dot" style={{ background: channelColor(channel) }} />
      {label}
    </span>
  );
}
