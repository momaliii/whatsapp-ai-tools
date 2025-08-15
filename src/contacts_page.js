'use strict';

const express = require('express');
const { listContacts } = require('./memory');
const { renderNav, showToast, setLoading, createDataTable } = require('./ui');

function createContactsPage(opts = {}) {
  const getClient = typeof opts.getClient === 'function' ? opts.getClient : () => null;
  const app = express.Router();

  app.get('/', async (req, res) => {
    const contacts = listContacts();
    let deviceContacts = [];
    try {
      const client = getClient();
      if (client && client.getChats) {
        const chats = await client.getChats();
        deviceContacts = chats.filter(c => !c.isGroup).map(c => ({
          number: c.id.user || c.id._serialized,
          name: c.name || c.pushname || '',
          lastActivity: c.lastMessage ? new Date(c.lastMessage.timestamp * 1000).toLocaleString() : '—'
        }));
      }
    } catch (error) {
      console.error('Error fetching device contacts:', error);
    }
    res.send(render(contacts, deviceContacts));
  });

  app.get('/export.csv', async (req, res) => {
    const contacts = listContacts();
    try {
      const client = getClient();
      if (client && client.getChats) {
        const chats = await client.getChats();
        chats.filter(c => !c.isGroup).forEach(c => {
          const number = c.id.user || c.id._serialized;
          if (!contacts.find(x => x.contactId === number)) {
            contacts.push({ contactId: number, count: 0, lastTs: 0 });
          }
        });
      }
    } catch (error) {
      console.error('Error fetching device contacts for export:', error);
    }
    const rows = [['Number', 'Name', 'Message Count', 'Last Activity', 'Status']]
      .concat(contacts.map(c => [
        c.contactId,
        c.name || '',
        String(c.count),
        c.lastTs ? new Date(c.lastTs).toISOString() : '',
        c.count > 0 ? 'Active' : 'Inactive'
      ]));
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts-export.csv"');
    res.send(csv);
  });

  app.get('/export.json', (req, res) => {
    const contacts = listContacts();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts-export.json"');
    res.json({ 
      contacts,
      exportDate: new Date().toISOString(),
      totalContacts: contacts.length,
      activeContacts: contacts.filter(c => c.count > 0).length
    });
  });

  // Rate limiting for contacts API
  const contactsApiCache = { data: null, timestamp: 0, ttl: 30000 }; // 30 seconds cache
  
  // API endpoint for AJAX requests
  app.get('/api/contacts', async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 5;
    const type = req.query.type || 'all'; // 'memory', 'device', 'all'
    
    // Check cache first (only for full data requests)
    const now = Date.now();
    if (contactsApiCache.data && (now - contactsApiCache.timestamp) < contactsApiCache.ttl && !req.query.page) {
      return res.json(contactsApiCache.data);
    }
    try {
      const contacts = listContacts();
      let deviceContacts = [];
      
      try {
        const client = getClient();
        if (client && client.getChats && client.isConnected) {
          // Check if client is ready and connected
          if (client.pupPage && !client.pupPage.isClosed()) {
            // Add timeout to prevent hanging
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Timeout getting chats')), 10000)
            );
            
            const chatsPromise = client.getChats();
            const chats = await Promise.race([chatsPromise, timeoutPromise]);
            
            deviceContacts = chats.filter(c => !c.isGroup).map(c => ({
              number: c.id.user || c.id._serialized,
              name: c.name || c.pushname || '',
              lastActivity: c.lastMessage ? new Date(c.lastMessage.timestamp * 1000).toLocaleString() : '—'
            }));
          } else {
            console.log('WhatsApp client page is closed or not ready');
          }
        } else {
          console.log('WhatsApp client not available or not connected');
        }
      } catch (error) {
        console.error('Error fetching device contacts:', error.message);
        // Don't throw the error, just log it and continue with empty device contacts
      }

      // Filter contacts based on type
      let filteredContacts = [];
      if (type === 'memory') {
        filteredContacts = contacts;
      } else if (type === 'device') {
        filteredContacts = deviceContacts;
      } else {
        // 'all' - combine both types
        filteredContacts = [...contacts, ...deviceContacts];
      }
      
      // Apply pagination
      const totalContacts = filteredContacts.length;
      const totalPages = Math.ceil(totalContacts / pageSize);
      const startIndex = (page - 1) * pageSize;
      const endIndex = startIndex + pageSize;
      const paginatedContacts = filteredContacts.slice(startIndex, endIndex);
      
      const response = {
        success: true,
        data: {
          contacts: paginatedContacts,
          pagination: {
            page,
            pageSize,
            totalContacts,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1
          },
          stats: {
            totalMemory: contacts.length,
            totalDevice: deviceContacts.length,
            activeContacts: contacts.filter(c => c.count > 0).length,
            totalMessages: contacts.reduce((acc, c) => acc + (c.count || 0), 0)
          }
        }
      };
      
      // Cache the response (only for full data requests)
      if (!req.query.page) {
        contactsApiCache.data = response;
        contactsApiCache.timestamp = now;
      }
      
      res.json(response);
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return app;
}

function renderContactsGrid(contacts, type) {
  if (contacts.length === 0) {
    return '<div class="empty-state">' +
      '<p>' + (type === 'memory' ? 'No memory contacts yet' : 'No device contacts found') + '</p>' +
      '<small>' + (type === 'memory' ? 'Contacts will appear here when you start conversations' : 'Connect your WhatsApp client to see device contacts') + '</small>' +
      '</div>';
  }

  return contacts.map(function(contact) {
    const contactId = contact.contactId || contact.number;
    const name = contact.name || contactId;
    const messageCount = contact.count || 0;
    const lastActivity = contact.lastTs ? new Date(contact.lastTs).toLocaleString() : (contact.lastActivity || '—');
    const avatar = 'https://ui-avatars.com/api/?name=' + encodeURIComponent(name) + '&background=random&size=48';
    
    return '<div class="contact-card" onclick="showContactDetails(\'' + escapeHtml(contactId) + '\', \'' + type + '\')">' +
      '<div class="contact-avatar">' +
        '<img src="' + avatar + '" alt="' + escapeHtml(name) + '">' +
      '</div>' +
      '<div class="contact-info">' +
        '<h4>' + escapeHtml(name) + '</h4>' +
        '<p>' + escapeHtml(contactId) + '</p>' +
        (type === 'memory' ? 
          '<div class="contact-stats">' +
            '<span class="badge badge-info">' + messageCount + ' messages</span>' +
            '<small>Last: ' + lastActivity + '</small>' +
          '</div>' : 
          '<div class="contact-stats">' +
            '<span class="badge badge-success">Device Contact</span>' +
            '<small>Last: ' + lastActivity + '</small>' +
          '</div>'
        ) +
      '</div>' +
      '<div class="contact-actions">' +
        '<button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); startConversation(\'' + escapeHtml(contactId) + '\')">' +
          '💬' +
        '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function render(contacts, deviceContacts) {
  const nav = renderNav('contacts');
  const memoryContacts = contacts || [];
  const deviceContactsList = deviceContacts || [];
  
  return '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
      '<meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<title>Contacts - WhatsApp AI</title>' +
      '<link rel="stylesheet" href="/assets/style.css">' +
      '<link rel="icon" href="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'><text y=\'.9em\' font-size=\'90\'>📇</text></svg>">' +
    '</head>' +
    '<body>' +
      '<div class="layout">' +
        nav +
        '<main class="main">' +
          '<div class="container">' +
            '<div class="contacts-header">' +
              '<h1>📇 Contacts</h1>' +
              '<p class="contacts-subtitle">Manage your WhatsApp contacts and conversations</p>' +
            '</div>' +

            '<!-- Stats Overview -->' +
            '<div class="stats-grid">' +
              '<div class="stat-card">' +
                '<div class="stat-icon">💬</div>' +
                '<div class="stat-content">' +
                  '<h3>' + memoryContacts.length + '</h3>' +
                  '<p>Memory Contacts</p>' +
                '</div>' +
              '</div>' +
              '<div class="stat-card">' +
                '<div class="stat-icon">📱</div>' +
                '<div class="stat-content">' +
                  '<h3>' + deviceContactsList.length + '</h3>' +
                  '<p>Device Contacts</p>' +
                '</div>' +
              '</div>' +
              '<div class="stat-card">' +
                '<div class="stat-icon">✅</div>' +
                '<div class="stat-content">' +
                  '<h3>' + memoryContacts.filter(function(c) { return c.count > 0; }).length + '</h3>' +
                  '<p>Active Contacts</p>' +
                '</div>' +
              '</div>' +
              '<div class="stat-card">' +
                '<div class="stat-icon">📊</div>' +
                '<div class="stat-content">' +
                  '<h3>' + memoryContacts.reduce(function(acc, c) { return acc + (c.count || 0); }, 0) + '</h3>' +
                  '<p>Total Messages</p>' +
                '</div>' +
              '</div>' +
            '</div>' +

            '<!-- Quick Actions -->' +
            '<div class="quick-actions">' +
              '<h2>⚡ Quick Actions</h2>' +
              '<div class="action-buttons">' +
                '<button class="btn btn-success" onclick="exportContacts(\'csv\')">' +
                  '<span>📤</span>' +
                  'Export CSV' +
                '</button>' +
                '<button class="btn btn-info" onclick="exportContacts(\'json\')">' +
                  '<span>📄</span>' +
                  'Export JSON' +
                '</button>' +
                '<button class="btn btn-warning" onclick="refreshContacts()">' +
                  '<span>🔄</span>' +
                  'Refresh' +
                '</button>' +
                '<button class="btn btn-outline" onclick="searchContacts()">' +
                  '<span>🔍</span>' +
                  'Search' +
                '</button>' +
              '</div>' +
            '</div>' +

            '<!-- Contacts Section -->' +
            '<div class="contacts-section">' +
              '<div class="section-header">' +
                '<h2>📇 All Contacts</h2>' +
                '<div class="section-actions">' +
                  '<div class="pagination-controls">' +
                    '<select id="pageSizeSelect" class="form-control" style="width: auto; margin-right: 10px;">' +
                      '<option value="5">5 per page</option>' +
                      '<option value="10">10 per page</option>' +
                      '<option value="25">25 per page</option>' +
                      '<option value="50">50 per page</option>' +
                      '<option value="100">100 per page</option>' +
                    '</select>' +
                    '<select id="contactTypeSelect" class="form-control" style="width: auto; margin-right: 10px;">' +
                      '<option value="all">All Contacts</option>' +
                      '<option value="memory">Memory Contacts</option>' +
                      '<option value="device">Device Contacts</option>' +
                    '</select>' +
                    '<input type="text" id="contactsSearch" placeholder="Search contacts..." class="form-control" style="max-width: 250px;">' +
                  '</div>' +
                '</div>' +
              '</div>' +
              
              '<div class="contacts-grid" id="contactsGrid">' +
                '<div class="loading">Loading contacts...</div>' +
              '</div>' +
              
              '<div class="pagination" id="pagination" style="display: none;">' +
                '<button class="btn btn-outline" id="prevPage" onclick="changePage(-1)">' +
                  '<span>←</span> Previous' +
                '</button>' +
                '<div class="page-info">' +
                  '<span id="pageInfo">Page 1 of 1</span>' +
                '</div>' +
                '<button class="btn btn-outline" id="nextPage" onclick="changePage(1)">' +
                  'Next <span>→</span>' +
                '</button>' +
              '</div>' +
            '</div>' +

            '<!-- Contact Details Modal -->' +
            '<div id="contactModal" class="modal">' +
              '<div class="modal-content">' +
                '<div class="modal-header">' +
                  '<h3 id="modalTitle">Contact Details</h3>' +
                  '<button class="btn btn-ghost modal-close" onclick="closeContactModal()">×</button>' +
                '</div>' +
                '<div class="modal-body" id="modalBody">' +
                  '<!-- Contact details will be loaded here -->' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</main>' +
      '</div>' +

      '<script>' +
        '(function() {' +
          '// Pagination state' +
          'let currentPage = 1;' +
          'let currentPageSize = 5;' +
          'let currentType = \'all\';' +
          'let currentSearch = \'\';' +
          'let allContacts = [];' +
          
          '// Initialize UI enhancements' +
          'initContactsPage();' +
          
          '// Load initial contacts' +
          'loadContacts();' +
          
          '// Pagination controls' +
          'const pageSizeSelect = document.getElementById(\'pageSizeSelect\');' +
          'const contactTypeSelect = document.getElementById(\'contactTypeSelect\');' +
          'const contactsSearch = document.getElementById(\'contactsSearch\');' +
          
          'if (pageSizeSelect) {' +
            'pageSizeSelect.addEventListener(\'change\', function() {' +
              'currentPageSize = parseInt(this.value);' +
              'currentPage = 1;' +
              'loadContacts();' +
            '});' +
          '}' +
          
          'if (contactTypeSelect) {' +
            'contactTypeSelect.addEventListener(\'change\', function() {' +
              'currentType = this.value;' +
              'currentPage = 1;' +
              'loadContacts();' +
            '});' +
          '}' +
          
          'if (contactsSearch) {' +
            'contactsSearch.addEventListener(\'input\', function() {' +
              'currentSearch = this.value;' +
              'currentPage = 1;' +
              'loadContacts();' +
            '});' +
          '}' +

          '// Load contacts with pagination' +
          'window.loadContacts = function() {' +
            'const contactsGrid = document.getElementById(\'contactsGrid\');' +
            'const pagination = document.getElementById(\'pagination\');' +
            'const pageInfo = document.getElementById(\'pageInfo\');' +
            'const prevBtn = document.getElementById(\'prevPage\');' +
            'const nextBtn = document.getElementById(\'nextPage\');' +
            '' +
            'contactsGrid.innerHTML = \'<div class="loading">Loading contacts...</div>\';' +
            'pagination.style.display = \'none\';' +
            '' +
            'const params = new URLSearchParams({' +
              'page: currentPage,' +
              'pageSize: currentPageSize,' +
              'type: currentType' +
            '});' +
            '' +
            'fetch(\'/api/contacts?\' + params)' +
              '.then(response => response.json())' +
              '.then(data => {' +
                'if (data.success) {' +
                  'allContacts = data.data.contacts;' +
                  'const paginationData = data.data.pagination;' +
                  '' +
                  '// Render contacts' +
                  'if (allContacts.length === 0) {' +
                    'contactsGrid.innerHTML = \'<div class="empty-state"><p>No contacts found</p></div>\';' +
                  '} else {' +
                    'contactsGrid.innerHTML = renderContactsGrid(allContacts, currentType);' +
                  '}' +
                  '' +
                  '// Update pagination' +
                  'if (paginationData.totalPages > 1) {' +
                    'pagination.style.display = \'flex\';' +
                    'pageInfo.textContent = `Page ${paginationData.page} of ${paginationData.totalPages} (${paginationData.totalContacts} total)`;' +
                    'prevBtn.disabled = !paginationData.hasPrev;' +
                    'nextBtn.disabled = !paginationData.hasNext;' +
                  '} else {' +
                    'pagination.style.display = \'none\';' +
                  '}' +
                '} else {' +
                  'contactsGrid.innerHTML = \'<div class="error">Failed to load contacts</div>\';' +
                '}' +
              '})' +
              '.catch(error => {' +
                'console.error(\'Error loading contacts:\', error);' +
                'contactsGrid.innerHTML = \'<div class="error">Error loading contacts</div>\';' +
              '});' +
          '};' +
          '' +
          '// Change page' +
          'window.changePage = function(delta) {' +
            'currentPage += delta;' +
            'if (currentPage < 1) currentPage = 1;' +
            'loadContacts();' +
          '};' +
          '' +
          '// Render contacts grid (client-side version)' +
          'function renderContactsGrid(contacts, type) {' +
            'if (contacts.length === 0) {' +
              'return \'<div class="empty-state"><p>No contacts found</p></div>\';' +
            '}' +
            '' +
            'return contacts.map(function(contact) {' +
              'const contactId = contact.contactId || contact.number;' +
              'const name = contact.name || contactId;' +
              'const messageCount = contact.count || 0;' +
              'const lastActivity = contact.lastTs ? new Date(contact.lastTs).toLocaleString() : (contact.lastActivity || \'—\');' +
              'const avatar = \'https://ui-avatars.com/api/?name=\' + encodeURIComponent(name) + \'&background=random&size=48\';' +
              '' +
              'let statsHtml = \'\';' +
              'if (type === \'memory\') {' +
                'statsHtml = \'<div class="contact-stats"><span class="badge badge-info">\' + messageCount + \' messages</span><small>Last: \' + lastActivity + \'</small></div>\';' +
              '} else {' +
                'statsHtml = \'<div class="contact-stats"><span class="badge badge-success">Device Contact</span><small>Last: \' + lastActivity + \'</small></div>\';' +
              '}' +
              '' +
              'return \'<div class="contact-card" onclick="showContactDetails(\\\'\' + escapeHtml(contactId) + \'\\\', \\\'\' + type + \'\\\')">\' +' +
                '\'<div class="contact-avatar"><img src="\' + avatar + \'" alt="\' + escapeHtml(name) + \'"></div>\' +' +
                '\'<div class="contact-info">\' +' +
                  '\'<h4>\' + escapeHtml(name) + \'</h4>\' +' +
                  '\'<p>\' + escapeHtml(contactId) + \'</p>\' +' +
                  statsHtml +
                '\'</div>\' +' +
                '\'<div class="contact-actions">\' +' +
                  '\'<button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); startConversation(\\\'\' + escapeHtml(contactId) + \'\\\')">💬</button>\' +' +
                '\'</div>\' +' +
              '\'</div>\';' +
            '}).join(\'\');' +
          '}' +
          '' +
          '// Refresh contacts' +
          'window.refreshContacts = function() {' +
            'loadContacts();' +
          '};' +
          '' +
          '// Search contacts' +
          'window.searchContacts = function() {' +
            'const searchInput = document.getElementById(\'contactsSearch\');' +
            'if (searchInput) {' +
              'searchInput.focus();' +
            '}' +
          '};' +
          '' +
          '// Export functions' +
          'window.exportContacts = function(format) {' +
            'setLoading(event.target, true);' +
            
            'const url = format === \'csv\' ? \'/contacts/export.csv\' : \'/contacts/export.json\';' +
            
            'fetch(url)' +
              '.then(response => {' +
                'if (format === \'csv\') {' +
                  'return response.blob();' +
                '} else {' +
                  'return response.json();' +
                '}' +
              '})' +
              '.then(data => {' +
                'if (format === \'csv\') {' +
                  'const url = URL.createObjectURL(data);' +
                  'const a = document.createElement(\'a\');' +
                  'a.href = url;' +
                  'a.download = \'contacts-export.csv\';' +
                  'a.click();' +
                  'URL.revokeObjectURL(url);' +
                '} else {' +
                  'const blob = new Blob([JSON.stringify(data, null, 2)], { type: \'application/json\' });' +
                  'const url = URL.createObjectURL(blob);' +
                  'const a = document.createElement(\'a\');' +
                  'a.href = url;' +
                  'a.download = \'contacts-export.json\';' +
                  'a.click();' +
                  'URL.revokeObjectURL(url);' +
                '}' +
                'showToast(\'Contacts exported as \' + format.toUpperCase() + \' successfully\', \'success\');' +
              '})' +
              '.catch(error => {' +
                'console.error(\'Export error:\', error);' +
                'showToast(\'Failed to export contacts\', \'error\');' +
              '})' +
              '.finally(() => {' +
                'setLoading(event.target, false);' +
              '});' +
          '};' +

          'window.refreshContacts = function() {' +
            'setLoading(event.target, true);' +
            
            'fetch(\'/contacts/api/contacts\')' +
              '.then(response => response.json())' +
              '.then(data => {' +
                'if (data.success) {' +
                  'document.getElementById(\'memoryContactsGrid\').innerHTML = ' +
                    'renderContactsGrid(data.data.memoryContacts, \'memory\');' +
                  'document.getElementById(\'deviceContactsGrid\').innerHTML = ' +
                    'renderContactsGrid(data.data.deviceContacts, \'device\');' +
                  
                  '// Update stats' +
                  'updateStats(data.data);' +
                  'showToast(\'Contacts refreshed successfully\', \'success\');' +
                '} else {' +
                  'showToast(\'Failed to refresh contacts\', \'error\');' +
                '}' +
              '})' +
              '.catch(error => {' +
                'console.error(\'Refresh error:\', error);' +
                'showToast(\'Failed to refresh contacts\', \'error\');' +
              '})' +
              '.finally(() => {' +
                'setLoading(event.target, false);' +
              '});' +
          '};' +

          'window.searchContacts = function() {' +
            'const query = prompt(\'Enter search term:\');' +
            'if (query) {' +
              'filterContacts(\'memory\', query);' +
              'filterContacts(\'device\', query);' +
              'showToast(\'Searching for: \' + query, \'info\');' +
            '}' +
          '};' +

          'window.showContactDetails = function(contactId, type) {' +
            'const modal = document.getElementById(\'contactModal\');' +
            'const modalTitle = document.getElementById(\'modalTitle\');' +
            'const modalBody = document.getElementById(\'modalBody\');' +
            
            'modalTitle.textContent = \'Contact: \' + contactId;' +
            'modalBody.innerHTML = ' +
              '\'<div class="contact-details">\' +' +
                '\'<p><strong>ID:</strong> \' + contactId + \'</p>\' +' +
                '\'<p><strong>Type:</strong> \' + type + \'</p>\' +' +
                '\'<p><strong>Last Updated:</strong> \' + new Date().toLocaleString() + \'</p>\' +' +
                '\'<div class="contact-actions">\' +' +
                  '\'<button class="btn btn-success" onclick="startConversation(\\\'\' + escapeHtml(contactId) + \'\\\')">\' +' +
                    '\'💬 Start Conversation\' +' +
                  '\'</button>\' +' +
                  '\'<button class="btn btn-info" onclick="viewHistory(\\\'\' + escapeHtml(contactId) + \'\\\')">\' +' +
                    '\'📜 View History\' +' +
                  '\'</button>\' +' +
                '\'</div>\' +' +
              '\'</div>\';' +
            
            'modal.classList.add(\'show\');' +
          '};' +

          'window.closeContactModal = function() {' +
            'document.getElementById(\'contactModal\').classList.remove(\'show\');' +
          '};' +

          'window.startConversation = function(contactId) {' +
            'showToast(\'Starting conversation with \' + contactId, \'info\');' +
            '// Navigate to conversation page' +
            'window.location.href = \'/convos\';' +
          '};' +

          'window.viewHistory = function(contactId) {' +
            'showToast(\'Viewing history for \' + contactId, \'info\');' +
            '// Navigate to conversation history' +
            'window.location.href = \'/convos\';' +
          '};' +

          'function filterContacts(type, query) {' +
            'const grid = document.getElementById(type + \'ContactsGrid\');' +
            'const cards = grid.querySelectorAll(\'.contact-card\');' +
            
            'cards.forEach(card => {' +
              'const text = card.textContent.toLowerCase();' +
              'const matches = text.includes(query.toLowerCase());' +
              'card.style.display = matches ? \'flex\' : \'none\';' +
            '});' +
          '}' +

          'function updateStats(data) {' +
            '// Update stat cards with new data' +
            'const statCards = document.querySelectorAll(\'.stat-card\');' +
            'if (statCards.length >= 4) {' +
              'statCards[0].querySelector(\'h3\').textContent = data.stats.totalMemory;' +
              'statCards[1].querySelector(\'h3\').textContent = data.stats.totalDevice;' +
              'statCards[2].querySelector(\'h3\').textContent = data.stats.activeContacts;' +
              'statCards[3].querySelector(\'h3\').textContent = data.memoryContacts.reduce((acc, c) => acc + (c.count || 0), 0);' +
            '}' +
          '}' +

          'function initContactsPage() {' +
            '// Initialize any page-specific functionality' +
            'console.log(\'Contacts page initialized\');' +
          '}' +

          '// Global toast function' +
          'function showToast(message, type = \'info\') {' +
            'const toast = document.createElement(\'div\');' +
            'toast.className = \'toast \' + type;' +
            'const icon = type === \'success\' ? \'✅\' : type === \'error\' ? \'❌\' : type === \'warning\' ? \'⚠️\' : \'ℹ️\';' +
            'toast.innerHTML = icon + \' \' + message;' +
            
            'document.body.appendChild(toast);' +
            'setTimeout(() => toast.classList.add(\'show\'), 10);' +
            
            'setTimeout(() => {' +
              'toast.classList.remove(\'show\');' +
              'setTimeout(() => {' +
                'if (toast.parentNode) {' +
                  'toast.parentNode.removeChild(toast);' +
                '}' +
              '}, 200);' +
            '}, 3000);' +
          '}' +

          '// Keyboard shortcuts' +
          'document.addEventListener(\'keydown\', function(e) {' +
            '// Ctrl/Cmd + E to export' +
            'if ((e.ctrlKey || e.metaKey) && e.key === \'e\') {' +
              'e.preventDefault();' +
              'exportContacts(\'csv\');' +
            '}' +
            
            '// Ctrl/Cmd + F to search' +
            'if ((e.ctrlKey || e.metaKey) && e.key === \'f\') {' +
              'e.preventDefault();' +
              'searchContacts();' +
            '}' +
            
            '// Escape to close modal' +
            'if (e.key === \'Escape\') {' +
              'closeContactModal();' +
            '}' +
          '});' +
        '})();' +
      '</script>' +
    '</body>' +
    '</html>';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = { createContactsPage };
