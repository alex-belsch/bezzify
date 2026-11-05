<?php declare(strict_types=1);

namespace Bezzify\Tracking\Subscriber;

use Bezzify\Tracking\Service\BezzifyClient;
use Shopware\Core\Framework\Struct\ArrayStruct;
use Shopware\Storefront\Page\Checkout\Finish\CheckoutFinishPageLoadedEvent;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;

class SurveySubscriber implements EventSubscriberInterface
{
    /** Merker in der Session je Bestellung, nach der Antwort verschwindet die Frage */
    public const ANSWERED = 'bezzify_survey_answered_';

    public function __construct(private readonly BezzifyClient $client)
    {
    }

    public static function getSubscribedEvents(): array
    {
        return [CheckoutFinishPageLoadedEvent::class => 'onFinishPage'];
    }

    public function onFinishPage(CheckoutFinishPageLoadedEvent $event): void
    {
        $order = $event->getPage()->getOrder();
        $request = $event->getRequest();
        if ($request->hasSession() && $request->getSession()->get(self::ANSWERED . $order->getId()) === true) {
            return;
        }
        $survey = $this->client->survey($event->getSalesChannelContext()->getSalesChannelId());
        if ($survey === null) {
            return;
        }
        $event->getPage()->addExtension('bezzifySurvey', new ArrayStruct($survey + ['orderId' => $order->getId()]));
    }
}
