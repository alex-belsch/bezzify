<?php declare(strict_types=1);

namespace Bezzify\Tracking\Service;

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;
use Psr\Log\LoggerInterface;
use Shopware\Core\System\SystemConfig\SystemConfigService;
use Symfony\Contracts\Cache\CacheInterface;
use Symfony\Contracts\Cache\ItemInterface;

class BezzifyClient
{
    public const OK = 'ok';
    /** Vorübergehend (Netzwerk, 5xx, 429, Zugangsdaten), später erneut versuchen */
    public const RETRY = 'retry';
    /** Daten ungültig, Wiederholen hilft nicht */
    public const FAIL = 'fail';

    public function __construct(
        private readonly SystemConfigService $config,
        private readonly LoggerInterface $logger,
        private readonly CacheInterface $cache
    ) {
    }

    /**
     * @param array<string, mixed> $payload
     */
    public function send(string $path, array $payload, ?string $salesChannelId = null): string
    {
        $endpoint = rtrim((string) $this->config->get('BezzifyTracking.config.endpoint', $salesChannelId), '/');
        $secret = (string) $this->config->get('BezzifyTracking.config.secretKey', $salesChannelId);
        if ($endpoint === '' || $secret === '') {
            return self::FAIL;
        }
        $client = new Client(['timeout' => 10, 'connect_timeout' => 5, 'http_errors' => false]);
        try {
            $response = $client->post($endpoint . $path, [
                // Ohne Daten als {} senden, ein leeres PHP Array würde zu []
                'json' => $payload === [] ? new \stdClass() : $payload,
                'headers' => ['Authorization' => 'Bearer ' . $secret],
            ]);
        } catch (GuzzleException $e) {
            $this->logger->warning('Bezzify: ' . $e->getMessage(), ['path' => $path, 'salesChannelId' => $salesChannelId]);

            return self::RETRY;
        }
        $code = $response->getStatusCode();
        if ($code >= 200 && $code < 300) {
            return self::OK;
        }
        $this->logger->warning('Bezzify: HTTP ' . $code, [
            'path' => $path,
            'salesChannelId' => $salesChannelId,
            'body' => substr((string) $response->getBody(), 0, 300),
        ]);

        return \in_array($code, [400, 413, 422], true) ? self::FAIL : self::RETRY;
    }

    /**
     * Frage und Antworten für die Danke Seite, zehn Minuten zwischengespeichert. Ist Bezzify nicht erreichbar, fehlt die Frage
     * eine Minute lang, die Abschlussseite wartet höchstens zwei Sekunden.
     *
     * @return array{question: string, answers: list<array{id: string, label: string}>}|null
     */
    public function survey(?string $salesChannelId): ?array
    {
        $endpoint = rtrim((string) $this->config->get('BezzifyTracking.config.endpoint', $salesChannelId), '/');
        $siteKey = (string) $this->config->get('BezzifyTracking.config.siteKey', $salesChannelId);
        if ($endpoint === '' || $siteKey === '') {
            return null;
        }

        return $this->cache->get('bezzify_survey_' . md5($endpoint . '|' . $siteKey), function (ItemInterface $item) use ($endpoint, $siteKey): ?array {
            $item->expiresAfter(60);
            try {
                $response = (new Client(['timeout' => 2, 'connect_timeout' => 2, 'http_errors' => false]))
                    ->get($endpoint . '/v1/survey', ['query' => ['k' => $siteKey]]);
            } catch (GuzzleException $e) {
                $this->logger->warning('Bezzify: Frage nach dem Kauf nicht abrufbar: ' . $e->getMessage());

                return null;
            }
            $survey = json_decode((string) $response->getBody(), true);
            if ($response->getStatusCode() !== 200 || !\is_array($survey)) {
                return null;
            }
            $item->expiresAfter(600);
            if (($survey['enabled'] ?? false) !== true || !\is_string($survey['question'] ?? null) || !\is_array($survey['answers'] ?? null)) {
                return null;
            }
            $answers = [];
            foreach ($survey['answers'] as $answer) {
                if (\is_array($answer) && \is_string($answer['id'] ?? null) && \is_string($answer['label'] ?? null)) {
                    $answers[] = ['id' => $answer['id'], 'label' => $answer['label']];
                }
            }

            return ['question' => $survey['question'], 'answers' => $answers];
        });
    }
}
