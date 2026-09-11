<?php
/**
 * Plugin Name: Project-owned blocks acceptance proof
 * Description: Test-owned dynamic blocks for the Block Runner continuation proof.
 * Version: 0.1.0
 * Requires at least: 6.7
 * Requires PHP: 8.1
 */

defined( 'ABSPATH' ) || exit;

function block_runner_project_owned_blocks_init(): void {
	register_block_type( __DIR__ . '/build/dynamic-hero' );
	register_block_type( __DIR__ . '/build/resource-list' );
}
add_action( 'init', 'block_runner_project_owned_blocks_init' );
