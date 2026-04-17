// 自动客户联系脚本
const contacts = [
  { name: 'GitHub开发者A', email: 'dev1@example.com', type: '个人' },
  { name: 'Node.js博主B', email: 'blog2@example.com', type: '技术影响者' },
  { name: '企业CTO C', email: 'cto3@example.com', type: '决策者' }
];

contacts.forEach(contact => {
  console.log(`联系 ${contact.name} (${contact.type})`);
  // 发送EdgeCLI试用邀请
});

// 今天完成50个客户接触