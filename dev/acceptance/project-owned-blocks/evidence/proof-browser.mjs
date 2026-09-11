#!/usr/bin/env node
// A deliberately small, local WordPress control for the project-owned block
// acceptance proof. It creates the proof post through the editor, not by
// serializing block markup in the harness.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
// Resolve the pinned browser from the Block Runner checkout rather than the
// consumer's build-only dependency tree.
import playwright from '../../../../node_modules/@playwright/test/index.js';
const { chromium } = playwright;

const options = new Map( process.argv.slice( 2 ).filter( ( _, index ) => index % 2 === 0 )
	.map( ( key, index ) => [ key, process.argv.slice( 2 )[ index * 2 + 1 ] ] ) );
const outputPath = options.get( '--out' );
const categoryId = Number( options.get( '--category' ) );
const emptyCategoryId = Number( options.get( '--empty-category' ) );
if ( ! outputPath || !Number.isInteger( categoryId ) || categoryId <= 0 || !Number.isInteger( emptyCategoryId ) || emptyCategoryId <= 0 ) {
	throw new Error( 'Usage: node proof-browser.mjs --category <published-id> --empty-category <draft-only-id> --out <absolute-result.json>' );
}

const baseUrl = 'http://localhost:8888';
const result = { runtime: { baseUrl, categoryId, emptyCategoryId }, editor: {}, errors: [] };
let browser;
let page;

try {
	browser = await chromium.launch( { headless: true } );
	page = await browser.newPage( { viewport: { width: 1280, height: 1000 } } );
	page.setDefaultTimeout( 20_000 );
	await login();
	const post = await page.evaluate( async () => wp.apiFetch( {
		path: '/wp/v2/posts', method: 'POST', data: { title: 'Project-owned browser proof', status: 'draft' },
	} ) );
	const postId = Number( post?.id );
	if ( !Number.isInteger( postId ) || postId <= 0 ) throw new Error( 'Could not create the local proof post.' );
	await page.goto( `${ baseUrl }/wp-admin/post.php?post=${ postId }&action=edit`, { waitUntil: 'domcontentloaded' } );
	await ready();

	for ( const name of [ 'Dynamic hero', 'Dynamic hero', 'Resource list', 'Resource list' ] ) await insert( name );
	await page.locator( 'button[aria-label="Close Block Inserter"]' ).click();
	const canvas = page.frameLocator( 'iframe[name="editor-canvas"]' );
	const heroes = canvas.locator( '.wp-block-example-dynamic-hero' );
	const lists = canvas.locator( '.wp-block-example-resource-list' );
	if ( await heroes.count() !== 2 || await lists.count() !== 2 ) throw new Error( 'The editor did not insert exactly two instances of each custom block.' );

	// Change only the second hero through its visible controls.
	await heroes.nth( 1 ).click();
	const chooseImage = page.getByRole( 'button', { name: 'Choose hero image', exact: true } );
	await assertFocusable( chooseImage, 'Choose hero image' );
	await chooseImage.click();
	await page.locator( 'li[aria-label="Project owned hero proof"]' ).click();
	await page.getByRole( 'button', { name: 'Select', exact: true } ).click();
	const focalLeft = page.getByLabel( 'Focal point left position' );
	const focalTop = page.getByLabel( 'Focal point top position' );
	await assertFocusable( focalLeft, 'Focal point left position' );
	await focalLeft.fill( '20' );
	await focalLeft.press( 'Tab' );
	await assertFocusable( focalTop, 'Focal point top position' );
	await focalTop.fill( '80' );
	await focalTop.press( 'Tab' );
	await page.getByRole( 'button', { name: 'Content', exact: true } ).click();
	const headingLevel = page.getByLabel( 'Heading level' );
	await assertFocusable( headingLevel, 'Heading level' );
	await headingLevel.selectOption( '3' );
	await heroes.nth( 1 ).getByRole( 'textbox', { name: 'Hero title', exact: true } ).fill( 'Second hero title' );
	await heroes.nth( 1 ).getByRole( 'textbox', { name: 'Hero subtitle', exact: true } ).fill( 'Second hero subtitle' );
	await heroes.nth( 1 ).getByRole( 'textbox', { name: 'Button text', exact: true } ).fill( 'Read the resource' );
	const insertLink = page.getByRole( 'button', { name: 'Insert link', exact: true } );
	await assertFocusable( insertLink, 'Insert link' );
	await insertLink.click();
	await page.locator( 'input[name^="url-input-control"]' ).fill( 'https://example.test/resource' );
	await page.locator( 'input[name^="url-input-control"]' ).press( 'Enter' );
	const openInNewTab = page.getByLabel( 'Open link in new tab', { exact: true } );
	await assertFocusable( openInNewTab, 'Open link in new tab' );
	await openInNewTab.check();

	// Select the parent after InnerBlocks focus, then save the native subtree with
	// an intentionally empty category before changing its filter/limit separately.
	await lists.nth( 1 ).focus();
	await page.keyboard.press( 'Escape' );
	const category = page.getByLabel( 'Category', { exact: true } );
	const initialLimit = page.locator( 'input[aria-label="Result limit"][type="number"]' );
	await assertFocusable( category, 'Category' );
	await category.selectOption( String( emptyCategoryId ) );
	await assertFocusable( initialLimit, 'Result limit' );
	await initialLimit.fill( '6' );
	await initialLimit.press( 'Tab' );
	await lists.nth( 1 ).getByRole( 'document', { name: 'Block: Heading 2', exact: true } ).fill( 'Updated resource introduction' );
	await lists.nth( 1 ).getByRole( 'document', { name: 'Block: Paragraph', exact: true } ).fill( 'This native introduction survives dynamic results.' );

	const beforeIntroductionSave = await editorState();
	await save( postId );
	const savedIntroduction = await editorState();
	await page.goto( `${ baseUrl }/wp-admin/post.php?post=${ postId }&action=edit`, { waitUntil: 'domcontentloaded' } );
	await ready();
	const afterIntroductionSave = await editorState();
	requireIntroductionState( afterIntroductionSave, emptyCategoryId );
	if ( afterIntroductionSave.dirty !== false ) throw new Error( 'The first reopened post is still dirty.' );

	const reopenedLists = canvas.locator( '.wp-block-example-resource-list' );
	await reopenedLists.nth( 1 ).focus();
	await page.keyboard.press( 'Escape' );
	const restoredCategory = page.getByLabel( 'Category', { exact: true } );
	const restoredLimit = page.locator( 'input[aria-label="Result limit"][type="number"]' );
	await restoredCategory.selectOption( String( categoryId ) );
	await restoredLimit.fill( '1' );
	await restoredLimit.press( 'Tab' );
	const beforeResultsSave = await editorState();
	await save( postId );
	await page.goto( `${ baseUrl }/wp-admin/post.php?post=${ postId }&action=edit`, { waitUntil: 'domcontentloaded' } );
	await ready();
	const reopened = await editorState();
	requireState( reopened, categoryId );
	if ( reopened.dirty !== false ) throw new Error( 'The second reopened post is still dirty.' );
	await mkdir( path.dirname( outputPath ), { recursive: true } );
	await page.screenshot( { path: path.join( path.dirname( outputPath ), 'project-owned-editor.png' ), fullPage: true } );
	const published = await page.evaluate( async ( id ) => wp.apiFetch( {
		path: `/wp/v2/posts/${ id }`, method: 'POST', data: { status: 'publish' },
	} ), postId );
	result.editor = { postId, permalink: published.link, beforeIntroductionSave, savedIntroduction, afterIntroductionSave, beforeResultsSave, reopened };
} catch ( error ) {
	result.errors.push( error instanceof Error ? error.message : String( error ) );
	if ( page ) await page.screenshot( { path: path.join( path.dirname( outputPath ), 'project-owned-editor-failure.png' ), fullPage: true } ).catch( () => undefined );
} finally {
	if ( browser ) await browser.close();
	await mkdir( path.dirname( outputPath ), { recursive: true } );
	await writeFile( outputPath, `${ JSON.stringify( result, null, 2 ) }\n` );
}
if ( result.errors.length ) process.exitCode = 1;

async function login() {
	if ( ! process.env.WP_PASSWORD ) throw new Error( 'WP_PASSWORD is required for the local browser proof.' );
	await page.goto( `${ baseUrl }/wp-login.php`, { waitUntil: 'domcontentloaded' } );
	if ( !page.url().includes( 'wp-login.php' ) ) return;
	await page.locator( '#user_login' ).fill( process.env.WP_USERNAME ?? 'admin' );
	await page.locator( '#user_pass' ).fill( process.env.WP_PASSWORD );
	await Promise.all( [ page.waitForURL( ( url ) => !url.pathname.endsWith( '/wp-login.php' ), { waitUntil: 'domcontentloaded' } ), page.locator( '#wp-submit' ).click() ] );
}

async function ready() {
	await page.waitForFunction( () => Boolean( wp?.data?.select( 'core/block-editor' )?.getBlocks ) );
	const welcome = page.getByRole( 'dialog', { name: /welcome to the editor/i } );
	if ( await welcome.isVisible().catch( () => false ) ) await welcome.getByRole( 'button', { name: /close/i } ).click();
}

async function insert( name ) {
	const inserter = page.locator( 'button[aria-label="Block Inserter"]' );
	if ( await inserter.getAttribute( 'aria-expanded' ) !== 'true' ) await inserter.click();
	const search = page.locator( 'input[placeholder="Search"]' );
	await search.fill( name );
	const tile = page.locator( 'button[role="option"]' ).filter( { hasText: name } ).first();
	await tile.waitFor( { state: 'visible' } );
	await tile.press( 'Enter' );
	await page.waitForTimeout( 350 );
}

async function save( postId ) {
	const save = page.getByRole( 'button', { name: /^save draft$/i } );
	const [ response ] = await Promise.all( [
		page.waitForResponse( ( candidate ) => candidate.request().method() === 'POST' && new URL( candidate.url() ).pathname.endsWith( `/wp/v2/posts/${ postId }` ) ),
		save.click(),
	] );
	if ( !response.ok() ) throw new Error( `Editor save returned HTTP ${ response.status() }.` );
	await page.waitForFunction( () => !wp.data.select( 'core/editor' ).isSavingPost() && wp.data.select( 'core/editor' ).isEditedPostDirty() === false );
}

async function editorState() {
	return page.evaluate( () => {
		const blocks = wp.data.select( 'core/block-editor' ).getBlocks();
		const serialise = ( block ) => ( { name: block.name, attributes: structuredClone( block.attributes ), inner: block.innerBlocks.map( serialise ), markup: wp.blocks.serialize( block.innerBlocks ), valid: block.isValid !== false } );
		return { dirty: wp.data.select( 'core/editor' ).isEditedPostDirty(), blocks: blocks.map( serialise ) };
	} );
}

function requireState( state, categoryId ) {
	const [ firstHero, secondHero, firstList, secondList ] = state.blocks;
	if ( state.blocks.length !== 4 || firstHero?.name !== 'example/dynamic-hero' || secondHero?.attributes?.imageId !== 6 || secondHero.attributes.titleLevel !== 3 || secondHero.attributes.buttonOpensInNewTab !== true || firstHero.attributes.imageId ) throw new Error( `Hero instances did not remain isolated: ${ JSON.stringify( state.blocks ) }` );
	if ( firstList?.name !== 'example/resource-list' || secondList?.attributes?.categoryId !== categoryId || secondList.attributes.limit !== 1 || secondList.inner.map( ( block ) => block.name ).join( ',' ) !== 'core/heading,core/paragraph' || !secondList.markup.includes( 'Updated resource introduction' ) || !secondList.markup.includes( 'This native introduction survives dynamic results.' ) ) throw new Error( `Resource-list instances did not retain independent native content: ${ JSON.stringify( state.blocks ) }` );
	const invalid = state.blocks.flatMap( function visit( block ) { return [ ...( block.valid ? [] : [ block.name ] ), ...block.inner.flatMap( visit ) ]; } );
	if ( invalid.length ) throw new Error( `Reopened editor contains invalid blocks: ${ invalid.join( ', ' ) }.` );
}

function requireIntroductionState( state, emptyCategoryId ) {
	const secondList = state.blocks[ 3 ];
	if ( secondList?.name !== 'example/resource-list' || secondList.attributes.categoryId !== emptyCategoryId || secondList.attributes.limit !== 6 || !secondList.markup.includes( 'Updated resource introduction' ) || !secondList.markup.includes( 'This native introduction survives dynamic results.' ) ) throw new Error( `Native introduction did not survive its first separate save/reopen: ${ JSON.stringify( state.blocks ) }` );
}

async function assertFocusable( locator, label ) {
	await locator.focus();
	const focused = await locator.evaluate( ( element ) => document.activeElement === element );
	if ( ! focused ) throw new Error( `${ label } did not accept keyboard focus.` );
}
