<?php declare(strict_types=1);

namespace Bezzify\Tracking\MessageHandler;

use Bezzify\Tracking\Message\BezzifyRequest;
use Bezzify\Tracking\Service\BezzifyClient;
use Psr\Log\LoggerInterface;
use Shopware\Core\Checkout\Order\OrderEntity;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Symfony\Component\Messenger\Attribute\AsMessageHandler;
use Symfony\Component\Messenger\Envelope;
use Symfony\Component\Messenger\MessageBusInterface;
use Symfony\Component\Messenger\Stamp\DelayStamp;

#[AsMessageHandler]
class BezzifyRequestHandler
{
    /** Minuten bis zum nächsten Versuch, nach dem letzten wird aufgegeben (knapp 15 Stunden insgesamt) */
    private const RETRY_MINUTES = [1, 5, 30, 120, 720];

    public function __construct(
        private readonly BezzifyClient $client,
        private readonly MessageBusInterface $bus,
        private readonly EntityRepository $orderRepository,
        private readonly LoggerInterface $logger
    ) {
    }

    public function __invoke(BezzifyRequest $message): void
    {
        $payload = $message->payload;
        if ($message->path === '/v1/orders' && $message->orderId !== null && $this->isCancelled($message->orderId)) {
            // inzwischen storniert, etwa während Bezzify nicht erreichbar war
            $payload['status'] = 'cancelled';
        }

        $outcome = $this->client->send($message->path, $payload, $message->salesChannelId);
        if ($outcome !== BezzifyClient::RETRY) {
            return;
        }
        if ($message->attempt >= \count(self::RETRY_MINUTES)) {
            $this->logger->error('Bezzify: Übertragung nach mehreren Versuchen aufgegeben', [
                'path' => $message->path,
                'orderId' => $message->orderId,
                'attempts' => $message->attempt + 1,
            ]);

            return;
        }
        // Nicht werfen, sonst wiederholt Messenger zusätzlich nach eigenem Schema
        $next = new BezzifyRequest($message->path, $payload, $message->salesChannelId, $message->orderId, $message->attempt + 1);
        $this->bus->dispatch(new Envelope($next, [new DelayStamp(self::RETRY_MINUTES[$message->attempt] * 60_000)]));
    }

    private function isCancelled(string $orderId): bool
    {
        $criteria = new Criteria([$orderId]);
        $criteria->addAssociation('stateMachineState');
        // Context::createCLIContext() wäre die öffentliche Variante, gibt es aber erst ab Shopware 6.6.1
        $order = $this->orderRepository->search($criteria, Context::createDefaultContext())->first();

        return $order instanceof OrderEntity && $order->getStateMachineState()?->getTechnicalName() === 'cancelled';
    }
}
