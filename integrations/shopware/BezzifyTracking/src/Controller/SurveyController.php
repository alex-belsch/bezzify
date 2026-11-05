<?php declare(strict_types=1);

namespace Bezzify\Tracking\Controller;

use Bezzify\Tracking\Message\BezzifyRequest;
use Bezzify\Tracking\Service\BezzifyClient;
use Bezzify\Tracking\Subscriber\SurveySubscriber;
use Shopware\Core\Checkout\Order\OrderEntity;
use Shopware\Core\Framework\DataAbstractionLayer\EntityRepository;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Criteria;
use Shopware\Core\Framework\DataAbstractionLayer\Search\Filter\EqualsFilter;
use Shopware\Core\Framework\Uuid\Uuid;
use Shopware\Core\System\SalesChannel\SalesChannelContext;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Messenger\MessageBusInterface;

/**
 * Nimmt die Antwort von der Abschlussseite an und schickt sie über die Warteschlange an Bezzify.
 * Die Route steht in Resources/config/routes.xml, so funktioniert sie von Shopware 6.5 bis 6.7 gleich.
 */
class SurveyController
{
    public function __construct(
        private readonly EntityRepository $orderRepository,
        private readonly BezzifyClient $client,
        private readonly MessageBusInterface $bus
    ) {
    }

    public function answer(Request $request, SalesChannelContext $context): JsonResponse
    {
        $customer = $context->getCustomer();
        $orderId = (string) $request->request->get('orderId', '');
        $answer = (string) $request->request->get('answer', '');
        if ($customer === null || !Uuid::isValid($orderId)) {
            return new JsonResponse(null, 403);
        }
        // wie auf der Abschlussseite selbst: die Bestellung muss zum angemeldeten Kunden oder Gast dieser Session gehören
        $criteria = new Criteria([$orderId]);
        $criteria->addFilter(new EqualsFilter('orderCustomer.customerId', $customer->getId()));
        $order = $this->orderRepository->search($criteria, $context->getContext())->first();
        if (!$order instanceof OrderEntity) {
            return new JsonResponse(null, 403);
        }
        $survey = $this->client->survey($context->getSalesChannelId());
        if ($survey === null || !\in_array($answer, array_column($survey['answers'], 'id'), true)) {
            return new JsonResponse(null, 400);
        }
        $session = $request->getSession();
        if ($session->get(SurveySubscriber::ANSWERED . $orderId) !== true) {
            $session->set(SurveySubscriber::ANSWERED . $orderId, true);
            $path = '/v1/orders/' . rawurlencode($order->getOrderNumber() ?? $order->getId()) . '/survey';
            $this->bus->dispatch(new BezzifyRequest($path, ['answer' => $answer], $context->getSalesChannelId()));
        }

        return new JsonResponse(['ok' => true]);
    }
}
