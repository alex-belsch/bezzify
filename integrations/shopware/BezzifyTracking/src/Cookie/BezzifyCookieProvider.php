<?php declare(strict_types=1);

namespace Bezzify\Tracking\Cookie;

use Shopware\Storefront\Framework\Cookie\CookieProviderInterface;

/**
 * Gruppe Bezzify im Cookie Consent Manager, bezzify-enabled erlaubt die Messung, bezzify-marketing die Rückspielung.
 * CookieProviderInterface ist ab 6.7.3 veraltet und bleibt bis 6.8, CookieGroupCollectEvent fehlt in 6.6.
 */
class BezzifyCookieProvider implements CookieProviderInterface
{
    public function __construct(private readonly CookieProviderInterface $original)
    {
    }

    public function getCookieGroups(): array
    {
        return array_merge($this->original->getCookieGroups(), [
            [
                'snippet_name' => 'bezzify.cookie.groupName',
                'snippet_description' => 'bezzify.cookie.groupDescription',
                'entries' => [
                    [
                        'snippet_name' => 'bezzify.cookie.measurement',
                        'snippet_description' => 'bezzify.cookie.measurementDescription',
                        'cookie' => 'bezzify-enabled',
                        'value' => '1',
                        'expiration' => '30',
                    ],
                    [
                        'snippet_name' => 'bezzify.cookie.marketing',
                        'snippet_description' => 'bezzify.cookie.marketingDescription',
                        'cookie' => 'bezzify-marketing',
                        'value' => '1',
                        'expiration' => '30',
                    ],
                ],
            ],
        ]);
    }
}
