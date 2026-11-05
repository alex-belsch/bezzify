<?php
/**
 * Plugin Name: Bezzify Tracking
 * Description: Adds the Bezzify tracking script, reports orders, cancellations and refunds to Bezzify server side and shows the optional post purchase question.
 * Version: 0.2.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * WC requires at least: 7.2
 * Author: RLA Digital Solutions
 * License: Proprietary
 * Text Domain: bezzify
 */

use Automattic\WooCommerce\Utilities\FeaturesUtil;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Bezzify_Woo {

	const OPTION          = 'bezzify_settings';
	const META_VISITOR    = '_bezzify_visitor_id';
	const META_MATCH      = '_bezzify_match';
	const META_SENT       = '_bezzify_sent_status';
	const META_SURVEY     = '_bezzify_survey_answer';
	const ACTION_ORDER    = 'bezzify_send_order';
	const ACTION_CANCEL   = 'bezzify_send_cancel';
	const ACTION_REFUND   = 'bezzify_send_refund';
	const ACTION_SURVEY   = 'bezzify_send_survey';
	const SURVEY_CACHE    = 'bezzify_survey';
	const GROUP           = 'bezzify';
	const VISITOR_PATTERN = '/^[A-Za-z0-9_-]{8,64}$/';
	const PAID_STATUSES   = array( 'processing', 'completed', 'refunded' );
	const FAILED_STATUSES = array( 'cancelled', 'failed' );
	// Minuten bis zum nächsten Versuch, nach dem letzten wird aufgegeben (knapp 15 Stunden insgesamt).
	const RETRY_MINUTES = array( 1, 5, 30, 120, 720 );
	const CONSENT_MODES = array(
		'required'  => "Cookie Banner ruft bezzify('consent', ...) auf",
		'cookiebot' => 'Cookiebot automatisch erkennen',
		'granted'   => 'Skript wird erst nach Marketing Einwilligung geladen',
		'analytics' => 'Skript wird nach Statistik Einwilligung geladen',
	);
	// Schickt die Antwort ohne neues Laden der Danke Seite, sonst lösten andere Pixel den Kauf ein zweites Mal aus.
	const SURVEY_SCRIPT = <<<'JS'
(function () {
	var box = document.querySelector('.bezzify-survey');
	if (!box || !window.fetch || !window.FormData) return;
	var buttons = box.querySelectorAll('button[value]');
	var setBusy = function (busy) {
		for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy;
	};
	box.addEventListener('click', function (event) {
		var button = event.target.closest('button[value]');
		if (!button) return;
		var body = new FormData();
		body.append('action', 'bezzify_survey');
		body.append('nonce', box.getAttribute('data-nonce'));
		body.append('order', box.getAttribute('data-order'));
		body.append('key', box.getAttribute('data-key'));
		body.append('answer', button.value);
		setBusy(true);
		fetch(box.getAttribute('data-url'), { method: 'POST', body: body, credentials: 'same-origin' })
			.then(function (response) {
				if (!response.ok) throw new Error('HTTP ' + response.status);
				box.querySelector('.bezzify-survey-answers').hidden = true;
				box.querySelector('.bezzify-survey-thanks').hidden = false;
			})
			// nach einem Fehler lässt sich erneut antworten
			.catch(function () { setBusy(false); });
	});
})();
JS;

	public static function init() {
		add_action( 'before_woocommerce_init', array( __CLASS__, 'declare_compatibility' ) );
		add_action( 'admin_menu', array( __CLASS__, 'admin_menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'wp_head', array( __CLASS__, 'print_snippet' ), 1 );
		add_action( 'woocommerce_checkout_order_processed', array( __CLASS__, 'capture_classic' ), 10, 3 );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( __CLASS__, 'capture_order' ) );
		add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'status_changed' ), 10, 3 );
		add_action( 'woocommerce_order_refunded', array( __CLASS__, 'refunded' ), 10, 2 );
		add_action( self::ACTION_ORDER, array( __CLASS__, 'send_order_async' ), 10, 3 );
		add_action( self::ACTION_CANCEL, array( __CLASS__, 'send_cancel_async' ), 10, 2 );
		add_action( self::ACTION_REFUND, array( __CLASS__, 'send_refund_async' ), 10, 3 );
		// Klassische Danke Seite und der Block "Weitere Informationen" der Bestellbestätigung lösen beide woocommerce_thankyou aus.
		add_action( 'woocommerce_thankyou', array( __CLASS__, 'render_survey' ), 20 );
		add_action( 'wp_ajax_bezzify_survey', array( __CLASS__, 'answer_survey' ) );
		add_action( 'wp_ajax_nopriv_bezzify_survey', array( __CLASS__, 'answer_survey' ) );
		add_action( self::ACTION_SURVEY, array( __CLASS__, 'send_survey_async' ), 10, 3 );
	}

	public static function declare_compatibility() {
		if ( class_exists( FeaturesUtil::class ) ) {
			FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
			FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', __FILE__, true );
		}
	}

	public static function settings() {
		$saved = get_option( self::OPTION, array() );
		return array_merge(
			array(
				'endpoint'   => '',
				'site_key'   => '',
				'secret_key' => '',
				'consent'    => 'required',
				'cookieless' => '0',
			),
			is_array( $saved ) ? $saved : array()
		);
	}

	public static function admin_menu() {
		add_options_page( 'Bezzify', 'Bezzify', 'manage_options', 'bezzify', array( __CLASS__, 'render_settings' ) );
	}

	public static function register_settings() {
		register_setting(
			'bezzify',
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
			)
		);
	}

	public static function sanitize( $input ) {
		$input    = is_array( $input ) ? $input : array();
		$endpoint = isset( $input['endpoint'] ) && is_string( $input['endpoint'] ) ? $input['endpoint'] : '';
		$secret   = isset( $input['secret_key'] ) ? sanitize_text_field( $input['secret_key'] ) : '';
		$consent  = isset( $input['consent'] ) ? $input['consent'] : '';
		return array(
			'endpoint'   => untrailingslashit( esc_url_raw( $endpoint, array( 'https', 'http' ) ) ),
			'site_key'   => isset( $input['site_key'] ) ? sanitize_text_field( $input['site_key'] ) : '',
			// Das Formular zeigt den Secret Key nie an, ein leeres Feld behält den gespeicherten.
			'secret_key' => '' !== $secret ? $secret : self::settings()['secret_key'],
			'consent'    => in_array( $consent, array_keys( self::CONSENT_MODES ), true ) ? $consent : 'required',
			'cookieless' => empty( $input['cookieless'] ) ? '0' : '1',
		);
	}

	public static function render_settings() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings = self::settings();
		$name     = self::OPTION;
		?>
		<div class="wrap">
			<h1>Bezzify</h1>
			<p>Endpoint, Site Key und Secret Key findest du im Bezzify Dashboard unter Einrichtung.</p>
			<form method="post" action="options.php">
				<?php settings_fields( 'bezzify' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="bzf-endpoint">Endpoint</label></th>
						<td><input id="bzf-endpoint" class="regular-text" type="url" name="<?php echo esc_attr( $name ); ?>[endpoint]" value="<?php echo esc_attr( $settings['endpoint'] ); ?>" placeholder="https://t.deinshop.de"></td>
					</tr>
					<tr>
						<th scope="row"><label for="bzf-site">Site Key</label></th>
						<td><input id="bzf-site" class="regular-text" type="text" name="<?php echo esc_attr( $name ); ?>[site_key]" value="<?php echo esc_attr( $settings['site_key'] ); ?>" placeholder="pk_..."></td>
					</tr>
					<tr>
						<th scope="row"><label for="bzf-secret">Secret Key</label></th>
						<td><input id="bzf-secret" class="regular-text" type="password" name="<?php echo esc_attr( $name ); ?>[secret_key]" value="" placeholder="<?php echo esc_attr( '' !== $settings['secret_key'] ? 'gespeichert, leer lassen zum Behalten' : 'sk_...' ); ?>" autocomplete="new-password"></td>
					</tr>
					<tr>
						<th scope="row"><label for="bzf-consent">Einwilligung</label></th>
						<td>
							<select id="bzf-consent" name="<?php echo esc_attr( $name ); ?>[consent]">
								<?php foreach ( self::CONSENT_MODES as $mode => $label ) : ?>
									<option value="<?php echo esc_attr( $mode ); ?>" <?php selected( $settings['consent'], $mode ); ?>><?php echo esc_html( $label ); ?></option>
								<?php endforeach; ?>
							</select>
							<p class="description">Für Borlabs, Real Cookie Banner oder Complianz als Opt In Code hinterlegen: bei Marketing <code>bezzify('consent','granted');</code>, bei Statistik <code>bezzify('consent','analytics');</code>. Käufe gehen nur mit Marketing Einwilligung an Werbeplattformen.</p>
						</td>
					</tr>
					<tr>
						<th scope="row">Ohne Einwilligung</th>
						<td>
							<label><input type="checkbox" name="<?php echo esc_attr( $name ); ?>[cookieless]" value="1" <?php checked( $settings['cookieless'], '1' ); ?>> anonyme Einstiege ohne Kennung zählen</label>
							<p class="description">Nach Ansicht der deutschen Datenschutzbehörden braucht auch das eine Einwilligung, weil das Skript Adresse und Herkunft der Seite ausliest (§ 25 TDDDG). Nur nach rechtlicher Prüfung einschalten.</p>
						</td>
					</tr>
					<tr>
						<th scope="row">Frage nach dem Kauf</th>
						<td><p class="description">Wird im Bezzify Dashboard unter Einrichtung eingeschaltet. Das Plugin zeigt sie dann auf der Danke Seite und leitet die Antwort mit dem Secret Key weiter.</p></td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}

	public static function print_snippet() {
		$settings = self::settings();
		if ( '' === $settings['endpoint'] || '' === $settings['site_key'] ) {
			return;
		}
		wp_print_inline_script_tag( 'window.bezzify=window.bezzify||function(){(bezzify.q=bezzify.q||[]).push(arguments)};' );
		$attributes = array(
			'async'        => true,
			'src'          => esc_url_raw( $settings['endpoint'] . '/t.js' ),
			'data-site'    => $settings['site_key'],
			'data-consent' => $settings['consent'],
		);
		if ( '1' === $settings['cookieless'] ) {
			$attributes['data-cookieless'] = 'true';
		}
		wp_print_script_tag( $attributes );
	}

	private static function cookie( $name ) {
		return isset( $_COOKIE[ $name ] ) ? sanitize_text_field( wp_unslash( $_COOKIE[ $name ] ) ) : '';
	}

	public static function capture_classic( $order_id, $posted_data = null, $order = null ) {
		self::capture_order( $order instanceof WC_Order ? $order : wc_get_order( $order_id ) );
	}

	/** Läuft im Request des Kunden, nur dort sind die Cookies verfügbar. */
	public static function capture_order( $order ) {
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		$level      = self::cookie( '_bzf_c' );
		$marketing  = '2' === $level;
		$visitor_id = self::cookie( '_bzf_id' );
		if ( ( $marketing || '1' === $level ) && preg_match( self::VISITOR_PATTERN, $visitor_id ) ) {
			$order->update_meta_data( self::META_VISITOR, $visitor_id );
		} else {
			$order->delete_meta_data( self::META_VISITOR );
		}
		$match = array( 'consent' => $marketing );
		// IP, User Agent und Werbecookies dienen nur der Rückspielung, also nur mit Marketing Einwilligung.
		if ( $marketing ) {
			$match += array(
				'ip'   => $order->get_customer_ip_address(),
				'ua'   => $order->get_customer_user_agent(),
				'fbp'  => self::cookie( '_fbp' ),
				'fbc'  => self::cookie( '_fbc' ),
				'ttp'  => self::cookie( '_ttp' ),
				'epik' => self::cookie( '_epik' ),
			);
		}
		$order->update_meta_data( self::META_MATCH, wp_json_encode( $match ) );
		$order->save_meta_data();
	}

	public static function status_changed( $order_id, $from, $to ) {
		if ( in_array( $to, array( 'processing', 'completed', 'on-hold' ), true ) ) {
			self::schedule( self::ACTION_ORDER, array( (int) $order_id, 'on-hold' === $to ? 'pending' : 'paid', 0 ) );
		} elseif ( in_array( $to, self::FAILED_STATUSES, true ) ) {
			self::schedule( self::ACTION_CANCEL, array( (int) $order_id, 0 ) );
		}
	}

	public static function refunded( $order_id, $refund_id ) {
		self::schedule( self::ACTION_REFUND, array( (int) $order_id, (int) $refund_id, 0 ) );
	}

	private static function schedule( $hook, $args, $delay_seconds = 0 ) {
		if ( $delay_seconds > 0 ) {
			as_schedule_single_action( time() + $delay_seconds, $hook, $args, self::GROUP );
		} else {
			as_enqueue_async_action( $hook, $args, self::GROUP );
		}
	}

	/** Erwartet die Argumente ohne Versuchszähler, nach dem letzten Versuch bleibt eine Notiz an der Bestellung. */
	private static function retry( $hook, $args, $attempt, $what, $order ) {
		if ( $attempt < count( self::RETRY_MINUTES ) ) {
			self::schedule( $hook, array_merge( $args, array( $attempt + 1 ) ), MINUTE_IN_SECONDS * self::RETRY_MINUTES[ $attempt ] );
			return;
		}
		self::log( 'error', 'Bestellung ' . $args[0] . ', ' . $what . ' nach ' . ( $attempt + 1 ) . ' Versuchen aufgegeben' );
		if ( $order instanceof WC_Order ) {
			$order->add_order_note( 'Bezzify: ' . $what . ' konnte nicht übertragen werden, bitte Verbindung prüfen.' );
		}
	}

	public static function send_order_async( $order_id, $status, $attempt = 0 ) {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		// Es zählt der Stand beim Senden, die Bestellung kann inzwischen storniert oder bezahlt sein.
		$current = $order->get_status();
		if ( in_array( $current, self::FAILED_STATUSES, true ) ) {
			$status = 'cancelled';
		} elseif ( in_array( $current, self::PAID_STATUSES, true ) ) {
			$status = 'paid';
		}
		if ( 'retry' === self::send_order( $order, $status ) ) {
			self::retry( self::ACTION_ORDER, array( (int) $order_id, $status ), (int) $attempt, 'Bestellung', $order );
		}
	}

	public static function send_cancel_async( $order_id, $attempt = 0 ) {
		$order = wc_get_order( $order_id );
		// Inzwischen wieder aktiv, etwa nach einem Ausfall von Bezzify, dann meldet der Auftrag der Bestellung den Stand.
		if ( $order instanceof WC_Order && in_array( $order->get_status(), array_merge( self::PAID_STATUSES, array( 'on-hold' ) ), true ) ) {
			return;
		}
		$delivery = self::post( '/v1/orders/' . rawurlencode( (string) $order_id ) . '/cancel', new stdClass(), 'Storno zu Bestellung ' . $order_id );
		// Eine nie übertragene Bestellung bleibt unmarkiert, damit ein ausstehender Versuch sie noch als storniert liefert.
		if ( 'ok' === $delivery && $order instanceof WC_Order && '' !== $order->get_meta( self::META_SENT ) ) {
			$order->update_meta_data( self::META_SENT, 'cancelled' );
			$order->save_meta_data();
		} elseif ( 'retry' === $delivery ) {
			self::retry( self::ACTION_CANCEL, array( (int) $order_id ), (int) $attempt, 'Storno', $order );
		}
	}

	public static function send_refund_async( $order_id, $refund_id, $attempt = 0 ) {
		$refund = wc_get_order( $refund_id );
		if ( ! $refund instanceof WC_Order_Refund ) {
			return;
		}
		$created  = $refund->get_date_created();
		$delivery = self::post(
			'/v1/refunds',
			array(
				'order_id'   => (string) $order_id,
				'refund_id'  => (string) $refund_id,
				'amount'     => abs( (float) $refund->get_amount() ),
				'created_at' => $created ? $created->format( DATE_ATOM ) : gmdate( DATE_ATOM ),
			),
			'Erstattung ' . $refund_id . ' zu Bestellung ' . $order_id
		);
		if ( 'retry' === $delivery ) {
			self::retry( self::ACTION_REFUND, array( (int) $order_id, (int) $refund_id ), (int) $attempt, 'Erstattung', wc_get_order( $order_id ) );
		}
	}

	/** Frage und Antworten aus Bezzify, zehn Minuten zwischengespeichert. Nach einem Fehler fehlt die Frage eine Minute lang. */
	private static function survey() {
		$cached = get_transient( self::SURVEY_CACHE );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		$settings = self::settings();
		$survey   = array( 'enabled' => false );
		$lifetime = MINUTE_IN_SECONDS;
		if ( '' !== $settings['endpoint'] && '' !== $settings['site_key'] ) {
			// Kurzes Timeout, die Danke Seite soll nicht auf Bezzify warten.
			$response = wp_remote_get( $settings['endpoint'] . '/v1/survey?k=' . rawurlencode( $settings['site_key'] ), array( 'timeout' => 2 ) );
			$body     = is_wp_error( $response ) ? null : json_decode( (string) wp_remote_retrieve_body( $response ), true );
			if ( is_array( $body ) && 200 === (int) wp_remote_retrieve_response_code( $response ) ) {
				$lifetime = 10 * MINUTE_IN_SECONDS;
				if ( ! empty( $body['enabled'] ) && isset( $body['question'], $body['answers'] ) && is_array( $body['answers'] ) ) {
					$survey = array(
						'enabled'  => true,
						'question' => (string) $body['question'],
						'answers'  => array_values( array_filter( $body['answers'], array( __CLASS__, 'is_answer' ) ) ),
					);
				}
			}
		}
		set_transient( self::SURVEY_CACHE, $survey, $lifetime );
		return $survey;
	}

	private static function is_answer( $answer ) {
		return is_array( $answer ) && isset( $answer['id'], $answer['label'] ) && is_string( $answer['id'] ) && is_string( $answer['label'] );
	}

	public static function render_survey( $order_id ) {
		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || '' !== (string) $order->get_meta( self::META_SURVEY ) ) {
			return;
		}
		$survey = self::survey();
		if ( empty( $survey['enabled'] ) ) {
			return;
		}
		?>
		<section class="bezzify-survey" data-url="<?php echo esc_url( admin_url( 'admin-ajax.php' ) ); ?>" data-order="<?php echo esc_attr( $order->get_id() ); ?>" data-key="<?php echo esc_attr( $order->get_order_key() ); ?>" data-nonce="<?php echo esc_attr( wp_create_nonce( 'bezzify_survey' ) ); ?>">
			<h2><?php echo esc_html( $survey['question'] ); ?></h2>
			<p class="bezzify-survey-answers">
				<?php foreach ( $survey['answers'] as $answer ) : ?>
					<button type="button" class="button" value="<?php echo esc_attr( $answer['id'] ); ?>"><?php echo esc_html( $answer['label'] ); ?></button>
				<?php endforeach; ?>
			</p>
			<p class="bezzify-survey-thanks" hidden>Danke für deine Antwort!</p>
		</section>
		<?php
		wp_print_inline_script_tag( self::SURVEY_SCRIPT );
	}

	/** Der Bestellschlüssel steht in der Adresse der Danke Seite und belegt, dass hier der Käufer selbst antwortet. */
	public static function answer_survey() {
		if ( ! check_ajax_referer( 'bezzify_survey', 'nonce', false ) ) {
			wp_send_json_error( null, 403 );
		}
		$order_id = isset( $_POST['order'] ) ? absint( wp_unslash( $_POST['order'] ) ) : 0;
		$key      = isset( $_POST['key'] ) ? sanitize_text_field( wp_unslash( $_POST['key'] ) ) : '';
		$answer   = isset( $_POST['answer'] ) ? sanitize_key( wp_unslash( $_POST['answer'] ) ) : '';
		$order    = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order || '' === $key || ! hash_equals( (string) $order->get_order_key(), $key ) ) {
			wp_send_json_error( null, 403 );
		}
		$survey = self::survey();
		$known  = empty( $survey['enabled'] ) ? array() : wp_list_pluck( $survey['answers'], 'id' );
		if ( ! in_array( $answer, $known, true ) ) {
			wp_send_json_error( null, 400 );
		}
		// Die erste Antwort zählt, ein erneutes Laden der Seite schickt nichts doppelt.
		if ( '' === (string) $order->get_meta( self::META_SURVEY ) ) {
			$order->update_meta_data( self::META_SURVEY, $answer );
			$order->save_meta_data();
			self::schedule( self::ACTION_SURVEY, array( (int) $order->get_id(), $answer, 0 ) );
		}
		wp_send_json_success();
	}

	public static function send_survey_async( $order_id, $answer, $attempt = 0 ) {
		$delivery = self::post( '/v1/orders/' . rawurlencode( (string) $order_id ) . '/survey', array( 'answer' => $answer ), 'Umfrage zu Bestellung ' . $order_id );
		if ( 'retry' === $delivery ) {
			self::retry( self::ACTION_SURVEY, array( (int) $order_id, $answer ), (int) $attempt, 'Antwort auf die Frage nach dem Kauf', null );
		}
	}

	private static function is_new_customer( WC_Order $order ) {
		$email   = $order->get_billing_email();
		$created = $order->get_date_created();
		if ( ! $email || ! $created ) {
			return null;
		}
		$earlier = wc_get_orders(
			array(
				'billing_email' => $email,
				'limit'         => 1,
				'return'        => 'ids',
				'status'        => array( 'wc-processing', 'wc-completed', 'wc-on-hold' ),
				'date_created'  => '<' . $created->getTimestamp(),
			)
		);
		return empty( $earlier );
	}

	/** Liefert ok, retry oder fail, ein schon übertragener Status zählt als ok. */
	private static function send_order( WC_Order $order, $status ) {
		if ( $order->get_meta( self::META_SENT ) === $status ) {
			return 'ok';
		}
		$match = json_decode( (string) $order->get_meta( self::META_MATCH ), true );
		$match = is_array( $match ) ? $match : array();
		$items = array();
		foreach ( $order->get_items() as $line_item ) {
			$product  = $line_item->get_product();
			$quantity = max( 1, (int) $line_item->get_quantity() );
			$items[]  = array(
				'id'       => (string) $line_item->get_product_id(),
				'sku'      => $product ? (string) $product->get_sku() : null,
				'name'     => $line_item->get_name(),
				'quantity' => $quantity,
				'price'    => round( ( (float) $line_item->get_total() + (float) $line_item->get_total_tax() ) / $quantity, 2 ),
			);
		}
		$created    = $order->get_date_created();
		$visitor_id = (string) $order->get_meta( self::META_VISITOR );
		$payload    = array(
			'order_id'          => (string) $order->get_id(),
			'order_number'      => (string) $order->get_order_number(),
			'created_at'        => $created ? $created->format( DATE_ATOM ) : gmdate( DATE_ATOM ),
			'currency'          => $order->get_currency(),
			'total'             => (float) $order->get_total(),
			'tax'               => (float) $order->get_total_tax(),
			'shipping'          => (float) $order->get_shipping_total() + (float) $order->get_shipping_tax(),
			'discount'          => (float) $order->get_discount_total(),
			'status'            => $status,
			'email'             => $order->get_billing_email() ? $order->get_billing_email() : null,
			'phone'             => $order->get_billing_phone() ? $order->get_billing_phone() : null,
			'customer_id'       => $order->get_customer_id() ? (string) $order->get_customer_id() : null,
			'is_new_customer'   => self::is_new_customer( $order ),
			'visitor_id'        => '' !== $visitor_id ? $visitor_id : null,
			'items'             => $items,
			'ip'                => ! empty( $match['ip'] ) ? $match['ip'] : null,
			'user_agent'        => ! empty( $match['ua'] ) ? $match['ua'] : null,
			'fbp'               => ! empty( $match['fbp'] ) ? $match['fbp'] : null,
			'fbc'               => ! empty( $match['fbc'] ) ? $match['fbc'] : null,
			'ttp'               => ! empty( $match['ttp'] ) ? $match['ttp'] : null,
			'epik'              => ! empty( $match['epik'] ) ? $match['epik'] : null,
			'consent_marketing' => ! empty( $match['consent'] ),
		);
		// WooCommerce Order Attribution (ab 8.5) als Rückfallebene, wenn das eigene Tracking fehlt.
		$entry    = $order->get_meta( '_wc_order_attribution_session_entry' );
		$referrer = $order->get_meta( '_wc_order_attribution_referrer' );
		if ( $entry ) {
			$payload['landing_url'] = (string) $entry;
		}
		if ( $referrer ) {
			$payload['referrer'] = (string) $referrer;
		}
		$delivery = self::post( '/v1/orders', $payload, 'Bestellung ' . $order->get_id() );
		if ( 'ok' === $delivery ) {
			$order->update_meta_data( self::META_SENT, $status );
			$order->save_meta_data();
		}
		return $delivery;
	}

	/** Liefert ok, retry (Netzwerk, 5xx, 429, Zugangsdaten) oder fail (Daten ungültig, Wiederholen hilft nicht). */
	private static function post( $path, $body, $context ) {
		$settings = self::settings();
		if ( '' === $settings['endpoint'] || '' === $settings['secret_key'] ) {
			return 'fail';
		}
		$response = wp_remote_post(
			$settings['endpoint'] . $path,
			array(
				'timeout' => 5,
				'headers' => array(
					'Content-Type'  => 'application/json',
					'Authorization' => 'Bearer ' . $settings['secret_key'],
				),
				'body'    => wp_json_encode( $body ),
			)
		);
		if ( is_wp_error( $response ) ) {
			self::log( 'warning', $context . ': ' . $response->get_error_message() );
			return 'retry';
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( $code >= 200 && $code < 300 ) {
			return 'ok';
		}
		self::log( 'warning', $context . ': HTTP ' . $code . ' ' . substr( wp_remote_retrieve_body( $response ), 0, 300 ) );
		return in_array( $code, array( 400, 413, 422 ), true ) ? 'fail' : 'retry';
	}

	private static function log( $level, $message ) {
		wc_get_logger()->log( $level, $message, array( 'source' => 'bezzify' ) );
	}
}

Bezzify_Woo::init();
