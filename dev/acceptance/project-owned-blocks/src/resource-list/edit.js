import { InnerBlocks, InspectorControls, useBlockProps } from '@wordpress/block-editor';
import { parse } from '@wordpress/blocks';
import { PanelBody, RangeControl, SelectControl } from '@wordpress/components';
import { useDispatch, useSelect } from '@wordpress/data';
import { useEffect, useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import { INITIAL_INTRODUCTION_MARKUP } from './introduction.js';

const ALLOWED_BLOCKS = [ 'core/heading', 'core/paragraph', 'core/list', 'core/buttons' ];

export default function Edit( { attributes, clientId, setAttributes } ) {
	const { categoryId, limit } = attributes;
	const { replaceInnerBlocks } = useDispatch( 'core/block-editor' );
	const seeded = useRef( false );
	const hasInnerBlocks = useSelect( ( select ) => ( select( 'core/block-editor' ).getBlock( clientId )?.innerBlocks.length ?? 0 ) > 0, [ clientId ] );
	const categories = useSelect( ( select ) => select( 'core' ).getEntityRecords( 'taxonomy', 'category', { per_page: -1 } ), [] );
	useEffect( () => {
		if ( seeded.current || hasInnerBlocks ) return;
		seeded.current = true;
		replaceInnerBlocks( clientId, parse( INITIAL_INTRODUCTION_MARKUP ), false );
	}, [ clientId, hasInnerBlocks, replaceInnerBlocks ] );
	const categoryOptions = [ { label: __( 'Choose a category', 'block-runner-project-owned-blocks' ), value: 0 } ].concat(
		( categories || [] ).map( ( category ) => ( { label: category.name, value: category.id } ) ),
	);
	return <>
		<InspectorControls><PanelBody title={ __( 'Results', 'block-runner-project-owned-blocks' ) }>
			<SelectControl label={ __( 'Category', 'block-runner-project-owned-blocks' ) } value={ categoryId } options={ categoryOptions } onChange={ ( value ) => setAttributes( { categoryId: Number( value ) } ) } />
			<RangeControl label={ __( 'Result limit', 'block-runner-project-owned-blocks' ) } value={ limit } onChange={ ( value ) => setAttributes( { limit: value } ) } min={ 1 } max={ 6 } />
		</PanelBody></InspectorControls>
		<section { ...useBlockProps( { className: 'example-resource-list' } ) }><InnerBlocks allowedBlocks={ ALLOWED_BLOCKS } templateLock={ false } /></section>
	</>;
}

Edit.save = function save() { return <InnerBlocks.Content />; };
