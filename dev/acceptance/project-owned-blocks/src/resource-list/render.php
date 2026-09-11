<?php
$category_id = isset( $attributes['categoryId'] ) ? absint( $attributes['categoryId'] ) : 0;
$limit = min( 6, max( 1, absint( $attributes['limit'] ?? 2 ) ) );
$query = new WP_Query( array( 'cat' => $category_id, 'posts_per_page' => $limit, 'post_status' => 'publish', 'no_found_rows' => true ) );
?>
<section <?php echo get_block_wrapper_attributes( array( 'class' => 'example-resource-list' ) ); ?>>
	<div class="example-resource-list__introduction"><?php echo do_blocks( $content ); ?></div>
	<?php if ( $query->have_posts() ) : ?><ul class="example-resource-list__results">
		<?php while ( $query->have_posts() ) : $query->the_post(); ?><li><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></li><?php endwhile; ?>
	</ul><?php else : ?><p class="example-resource-list__empty"><?php esc_html_e( 'No resources found.', 'block-runner-project-owned-blocks' ); ?></p><?php endif; ?>
</section>
<?php wp_reset_postdata(); ?>
