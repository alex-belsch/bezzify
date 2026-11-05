<?php declare(strict_types=1);

namespace Bezzify\Tracking\Message;

use Shopware\Core\Framework\MessageQueue\AsyncMessageInterface;

/**
 * Aufruf der Server API über die Nachrichtenwarteschlange, damit der Checkout nicht auf Bezzify wartet und Ausfälle
 * später wiederholt werden.
 */
class BezzifyRequest implements AsyncMessageInterface
{
    /**
     * @param array<string, mixed> $payload
     */
    public function __construct(
        public readonly string $path,
        public readonly array $payload,
        public readonly ?string $salesChannelId = null,
        public readonly ?string $orderId = null,
        public readonly int $attempt = 0
    ) {
    }
}
