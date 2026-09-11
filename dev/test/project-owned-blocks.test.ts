import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { realize } from '../../src/index.js';

const root = path.resolve( import.meta.dirname, '../acceptance/project-owned-blocks' );
const source = ( ...parts: string[] ) => readFile( path.join( root, ...parts ), 'utf8' );

describe( 'project-owned custom-block consumer', () => {
	it( 'keeps two ordinary blocks in a registered, buildable consumer plugin', async () => {
		const [ manifest, plugin, readme ] = await Promise.all( [ source( 'package.json' ), source( 'project-owned-blocks.php' ), source( 'README.md' ) ] );
		expect( JSON.parse( manifest ) ).toMatchObject( { scripts: { build: expect.stringContaining( 'wp-scripts build' ) } } );
		expect( plugin ).toContain( "register_block_type( __DIR__ . '/build/dynamic-hero' )" );
		expect( plugin ).toContain( "register_block_type( __DIR__ . '/build/resource-list' )" );
		expect( readme ).toContain( 'npm install' );
		expect( readme ).toContain( 'npm run build' );
	} );

	it( 'keeps the specified dynamic hero parent contract and attachment-only responsive rendering', async () => {
		const [ metadata, edit, renderer ] = await Promise.all( [
			source( 'src/dynamic-hero/block.json' ), source( 'src/dynamic-hero/edit.js' ), source( 'src/dynamic-hero/render.php' ),
		] );
		expect( JSON.parse( metadata ) ).toMatchObject( {
			name: 'example/dynamic-hero',
			attributes: {
				imageId: { type: 'number' }, imageUrl: { type: 'string' }, focalPoint: { type: 'object' },
				title: { type: 'string' }, titleLevel: { type: 'number' }, subtitle: { type: 'string' },
				buttonText: { type: 'string' }, buttonUrl: { type: 'string' }, buttonOpensInNewTab: { type: 'boolean' },
			},
		} );
		expect( edit ).toContain( 'MediaUpload' );
		expect( edit ).toContain( 'FocalPointPicker' );
		expect( edit ).toContain( 'RichText' );
		expect( edit ).toContain( 'Heading level' );
		expect( edit ).toContain( 'URLInputButton' );
		expect( renderer ).toContain( 'wp_get_attachment_image' );
		expect( renderer ).toContain( "'fetchpriority' => 'high'" );
		expect( renderer ).toContain( "'loading'       => 'eager'" );
		expect( renderer ).toContain( 'wp_attachment_is_image' );
		expect( renderer ).toContain( 'wp_kses_post' );
		expect( renderer ).toContain( 'esc_url' );
	} );

	it( 'retains the actual assembled native introduction beside the current custom query', async () => {
		const [ intent, retained, edit, renderer ] = await Promise.all( [
			source( 'src/resource-list/introduction.intent.json' ), source( 'src/resource-list/introduction.js' ),
			source( 'src/resource-list/edit.js' ), source( 'src/resource-list/render.php' ),
		] );
		const report = await realize( intent );
		expect( report.ok ).toBe( true );
		expect( retained ).toContain( report.output! );
		expect( edit ).toContain( 'parse( INITIAL_INTRODUCTION_MARKUP )' );
		expect( edit ).toContain( 'replaceInnerBlocks( clientId' );
		expect( edit ).toContain( '<InnerBlocks.Content />' );
		expect( renderer ).toContain( 'do_blocks( $content )' );
		expect( renderer ).toContain( "'post_status' => 'publish'" );
		expect( renderer ).toContain( 'new WP_Query' );
	} );
} );
