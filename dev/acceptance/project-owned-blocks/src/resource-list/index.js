import { registerBlockType } from '@wordpress/blocks';
import metadata from './block.json';
import Edit from './edit.js';
import './style.css';

registerBlockType( metadata.name, { ...metadata, edit: Edit, save: Edit.save } );
