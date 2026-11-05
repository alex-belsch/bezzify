<?php declare(strict_types=1);

namespace Bezzify\Tracking\Subscriber;

use Bezzify\Tracking\Message\BezzifyRequest;
use Shopware\Core\Checkout\Cart\Event\CheckoutOrderPlacedEvent;
use Shopware\Core\Checkout\Cart\LineItem\LineItem;
use Shopware\Core\Checkout\Order\Aggregate\OrderTransaction\OrderTransactionEntity;
use Shopware\Core\Checkout\Order\OrderEntity;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\System\StateMachine\Event\StateMachineStateChangeEvent;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\Messenger\MessageBusInterface;

class OrderSubscriber implements EventSubscriberInterface
{
    public function __construct(
        private readonly MessageBusInterface $bus,
        private readonly RequestStack $requestStack,
        private readonly EntityRepository $orderRepository,
        private readonly EntityRepository $transactionRepository
    ) {
    }

    public static function getSubscribedEvents(): array
    {
        return [
            CheckoutOrderPlacedEvent::class => 'onOrderPlaced',
            'state_enter.order.state.cancelled' => 'onOrderCancelled',
            'state_enter.order_transaction.state.refunded' => 'onTransactionRefunded',
        ];
    }

    public function onOrderPlaced(CheckoutOrderPlacedEvent $event): void
    {
        $order = $event->getOrder();
        $request = $this->requestStack->getCurrentRequest();
        $cookies = $request?->cookies;
        // Einwilligung aus dem Consent Manager (Gruppe Bezzify) oder aus _bzf_c des Tracking Skripts
        $level = (string) ($cookies?->get('_bzf_c') ?? '');
        $marketing = $level === '2' || $cookies?->get('bezzify-marketing') === '1';
        $tracking = $marketing || $level === '1' || $cookies?->get('bezzify-enabled') === '1';
        $visitorId = (string) ($cookies?->get('_bzf_id') ?? '');
        if (!$tracking || !preg_match('/^[A-Za-z0-9_-]{8,64}$/', $visitorId)) {
            $visitorId = '';
        }

        $items = [];
        foreach ($order->getLineItems() ?? [] as $lineItem) {
            if ($lineItem->getType() !== LineItem::PRODUCT_LINE_ITEM_TYPE) {
                continue;
            }
            $items[] = [
                'id' => $lineItem->getProductId() ?? $lineItem->getIdentifier(),
                'sku' => $lineItem->getPayload()['productNumber'] ?? null,
                'name' => $lineItem->getLabel(),
                'quantity' => $lineItem->getQuantity(),
                'price' => round($lineItem->getUnitPrice(), 2),
            ];
        }

        $customer = $order->getOrderCustomer();
        $payload = [
            'order_id' => $this->externalId($order),
            'order_number' => $order->getOrderNumber(),
            'created_at' => $order->getOrderDateTime()->format(\DATE_ATOM),
            // Ohne Währung nimmt Bezzify die des Shops
            'currency' => $order->getCurrency()?->getIsoCode(),
            'total' => round($order->getAmountTotal(), 2),
            'tax' => round($order->getAmountTotal() - $order->getAmountNet(), 2),
            'shipping' => round($order->getShippingTotal(), 2),
            'status' => 'paid',
            'email' => $customer?->getEmail(),
            'customer_id' => $customer?->getCustomerId(),
            'visitor_id' => $visitorId !== '' ? $visitorId : null,
            'items' => $items,
            'consent_marketing' => $marketing,
        ];
        // IP, User Agent und Werbecookies dienen nur der Rückspielung, also nur mit Marketing Einwilligung
        if ($marketing && $request !== null) {
            $payload['ip'] = $request->getClientIp();
            $payload['user_agent'] = $request->headers->get('User-Agent');
            foreach (['fbp' => '_fbp', 'fbc' => '_fbc', 'ttp' => '_ttp', 'epik' => '_epik'] as $field => $cookie) {
                $value = $cookies?->get($cookie);
                if (\is_string($value) && $value !== '') {
                    $payload[$field] = $value;
                }
            }
        }
        $this->bus->dispatch(new BezzifyRequest('/v1/orders', $payload, $event->getSalesChannelId(), $order->getId()));
    }

    public function onOrderCancelled(StateMachineStateChangeEvent $event): void
    {
        $orderId = $event->getTransition()->getEntityId();
        $order = $this->orderRepository->search(new Criteria([$orderId]), $event->getContext())->first();
        if (!$order instanceof OrderEntity) {
            return;
        }
        $path = '/v1/orders/' . rawurlencode($this->externalId($order)) . '/cancel';
        $this->bus->dispatch(new BezzifyRequest($path, [], $order->getSalesChannelId()));
    }

    public function onTransactionRefunded(StateMachineStateChangeEvent $event): void
    {
        $criteria = new Criteria([$event->getTransition()->getEntityId()]);
        $criteria->addAssociation('order');
        $transaction = $this->transactionRepository->search($criteria, $event->getContext())->first();
        if (!$transaction instanceof OrderTransactionEntity || $transaction->getOrder() === null) {
            return;
        }
        $order = $transaction->getOrder();
        $this->bus->dispatch(new BezzifyRequest('/v1/refunds', [
            'order_id' => $this->externalId($order),
            'refund_id' => $transaction->getId(),
            'amount' => round($transaction->getAmount()->getTotalPrice(), 2),
            'created_at' => (new \DateTimeImmutable())->format(\DATE_ATOM),
        ], $order->getSalesChannelId()));
    }

    private function externalId(OrderEntity $order): string
    {
        return $order->getOrderNumber() ?? $order->getId();
    }
}
