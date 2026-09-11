<?php
// This example deliberately uses attachment metadata; it never invents srcset candidates.
if ( ! function_exists( 'block_runner_project_owned_hero_image' ) ) {
	function block_runner_project_owned_hero_image( int $image_id, float $focal_x, float $focal_y ): string {
		if ( ! $image_id || ! wp_attachment_is_image( $image_id ) ) {
			return '';
		}

		return wp_get_attachment_image(
			$image_id,
			'full',
			false,
			array(
				'loading'       => 'eager',
				'fetchpriority' => 'high',
				'decoding'      => 'async',
				'class'         => 'example-dynamic-hero__image',
				'style'         => sprintf( 'object-position: %.2f%% %.2f%%;', $focal_x, $focal_y ),
			)
		);
	}
}

$image_id = isset( $attributes['imageId'] ) ? absint( $attributes['imageId'] ) : 0;
$image_url = isset( $attributes['imageUrl'] ) ? esc_url( $attributes['imageUrl'] ) : '';
$focal = isset( $attributes['focalPoint'] ) && is_array( $attributes['focalPoint'] ) ? $attributes['focalPoint'] : array( 'x' => 0.5, 'y' => 0.5 );
$focal_x = min( 1, max( 0, (float) ( $focal['x'] ?? 0.5 ) ) ) * 100;
$focal_y = min( 1, max( 0, (float) ( $focal['y'] ?? 0.5 ) ) ) * 100;
$level = min( 6, max( 1, absint( $attributes['titleLevel'] ?? 1 ) ) );
$title = $attributes['title'] ?? '';
$subtitle = $attributes['subtitle'] ?? '';
$button_text = $attributes['buttonText'] ?? '';
$button_url = isset( $attributes['buttonUrl'] ) ? esc_url( $attributes['buttonUrl'] ) : '';
$new_tab = ! empty( $attributes['buttonOpensInNewTab'] );
$image = block_runner_project_owned_hero_image( $image_id, $focal_x, $focal_y );
?>
<section <?php echo get_block_wrapper_attributes( array( 'class' => 'example-dynamic-hero', 'style' => sprintf( '--hero-focal: %s%% %s%%;', esc_attr( $focal_x ), esc_attr( $focal_y ) ) ) ); ?>>
	<?php if ( $image ) : ?>
		<?php // The helper returns WordPress-generated attachment markup, including srcset and sizes. ?>
		<?php echo $image; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>
	<?php elseif ( $image_url ) : ?>
		<img class="example-dynamic-hero__image" src="<?php echo esc_url( $image_url ); ?>" alt="" loading="eager" fetchpriority="high" />
	<?php else : ?>
		<p class="example-dynamic-hero__missing-image">Choose a hero image to complete this hero.</p>
	<?php endif; ?>
	<div class="example-dynamic-hero__content">
		<?php if ( $title ) : ?><h<?php echo esc_attr( $level ); ?>><?php echo wp_kses_post( $title ); ?></h<?php echo esc_attr( $level ); ?>><?php endif; ?>
		<?php if ( $subtitle ) : ?><p><?php echo wp_kses_post( $subtitle ); ?></p><?php endif; ?>
		<?php if ( $button_text && $button_url ) : ?><a href="<?php echo esc_url( $button_url ); ?>"<?php echo $new_tab ? ' target="_blank" rel="noreferrer noopener"' : ''; ?>><?php echo wp_kses_post( $button_text ); ?></a><?php endif; ?>
	</div>
</section>
