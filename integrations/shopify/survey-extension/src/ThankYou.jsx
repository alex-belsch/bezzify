// Freiwillige Frage auf der Danke Seite. Die Antwort geht mit dem Checkout Token an Bezzify, den nur der Käufer kennt;
// Bezzify ordnet sie damit der Bestellung aus dem Webhook zu.
import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** @typedef {{ enabled: true, question: string, answers: { id: string, label: string }[] }} SurveyConfig */

export default function extension() {
  render(<Survey />, document.body);
}

function Survey() {
  const endpoint = String(shopify.settings.value.endpoint ?? '').trim().replace(/\/+$/, '');
  const siteKey = String(shopify.settings.value.site_key ?? '').trim();
  const checkoutToken = shopify.checkoutToken.value;
  const [survey, setSurvey] = useState(/** @type {SurveyConfig | null} */ (null));
  const [state, setState] = useState('open');

  useEffect(() => {
    if (!endpoint || !siteKey) return undefined;
    let current = true;
    fetch(`${endpoint}/v1/survey?k=${encodeURIComponent(siteKey)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((config) => {
        if (current) setSurvey(config && config.enabled ? config : null);
      })
      // ohne Antwort von Bezzify bleibt der Block leer, der Käufer merkt davon nichts
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [endpoint, siteKey]);

  if (!survey || !checkoutToken) return null;
  if (state === 'done') return <s-banner tone="success" heading="Danke für deine Antwort" />;

  const send = async (/** @type {string} */ answer) => {
    setState('sending');
    try {
      const response = await fetch(`${endpoint}/v1/survey`, {
        method: 'POST',
        // text/plain spart die Vorabanfrage, Bezzify liest den Inhalt trotzdem als JSON
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ k: siteKey, checkout_token: checkoutToken, answer }),
      });
      setState(response.ok ? 'done' : 'failed');
    } catch {
      setState('failed');
    }
  };

  return (
    <s-stack gap="base">
      <s-heading>{survey.question}</s-heading>
      <s-stack direction="inline" gap="small-200">
        {survey.answers.map((answer) => (
          <s-button key={answer.id} variant="secondary" disabled={state === 'sending'} onClick={() => send(answer.id)}>
            {answer.label}
          </s-button>
        ))}
      </s-stack>
      {state === 'failed' && <s-text tone="critical">Das hat nicht geklappt, bitte noch einmal wählen.</s-text>}
    </s-stack>
  );
}
