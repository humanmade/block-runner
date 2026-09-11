import { RichText, MediaUpload, MediaUploadCheck, InspectorControls, URLInputButton, useBlockProps } from '@wordpress/block-editor';
import { Button, FocalPointPicker, PanelBody, SelectControl, ToggleControl } from '@wordpress/components';
import { __ } from '@wordpress/i18n';

const levels = [ 1, 2, 3, 4, 5, 6 ].map( ( value ) => ( { label: `H${ value }`, value } ) );

export default function Edit( { attributes, setAttributes } ) {
	const { imageId, imageUrl, focalPoint, title, titleLevel, subtitle, buttonText, buttonUrl, buttonOpensInNewTab } = attributes;
	const blockProps = useBlockProps( {
		className: 'example-dynamic-hero',
		style: imageUrl ? { backgroundImage: `url(${ imageUrl })`, backgroundPosition: `${ focalPoint.x * 100 }% ${ focalPoint.y * 100 }%` } : undefined,
	} );
	const Heading = `h${ titleLevel }`;
	return <>
		<InspectorControls>
			<PanelBody title={ __( 'Hero media', 'block-runner-project-owned-blocks' ) }>
				<MediaUploadCheck><MediaUpload value={ imageId } allowedTypes={ [ 'image' ] } onSelect={ ( image ) => setAttributes( { imageId: image.id, imageUrl: image.url } ) } render={ ( { open } ) => <Button variant="secondary" onClick={ open }>{ imageUrl ? __( 'Replace image', 'block-runner-project-owned-blocks' ) : __( 'Choose hero image', 'block-runner-project-owned-blocks' ) }</Button> } /></MediaUploadCheck>
				{ imageUrl && <FocalPointPicker url={ imageUrl } value={ focalPoint } onChange={ ( value ) => setAttributes( { focalPoint: value } ) } /> }
			</PanelBody>
			<PanelBody title={ __( 'Content', 'block-runner-project-owned-blocks' ) } initialOpen={ false }>
				<SelectControl label={ __( 'Heading level', 'block-runner-project-owned-blocks' ) } value={ titleLevel } options={ levels } onChange={ ( value ) => setAttributes( { titleLevel: Number( value ) } ) } />
				<URLInputButton url={ buttonUrl } onChange={ ( value ) => setAttributes( { buttonUrl: value } ) } />
				<ToggleControl label={ __( 'Open link in new tab', 'block-runner-project-owned-blocks' ) } checked={ buttonOpensInNewTab } onChange={ ( value ) => setAttributes( { buttonOpensInNewTab: value } ) } />
			</PanelBody>
		</InspectorControls>
		<section { ...blockProps }>
			<RichText tagName={ Heading } value={ title } placeholder={ __( 'Hero title', 'block-runner-project-owned-blocks' ) } onChange={ ( value ) => setAttributes( { title: value } ) } />
			<RichText tagName="p" value={ subtitle } placeholder={ __( 'Hero subtitle', 'block-runner-project-owned-blocks' ) } onChange={ ( value ) => setAttributes( { subtitle: value } ) } />
			<RichText tagName="a" value={ buttonText } placeholder={ __( 'Button text', 'block-runner-project-owned-blocks' ) } onChange={ ( value ) => setAttributes( { buttonText: value } ) } />
		</section>
	</>;
}
