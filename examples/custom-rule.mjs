export default {
  rules: {
    custom: [
      {
        id: 'notice-paragraph',
        match: (node) => node.matches('p[data-notice]'),
        emit: async (node, { wp }) => wp.createBlock('core/paragraph', {
          content: node.innerHTML,
          className: 'notice',
        }),
      },
    ],
  },
};
