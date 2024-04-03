import * as d3 from 'd3';

export function renderBrainAnimation(containerEl: HTMLElement): void {
  const width = 500;
  const height = 100;
  const padding = 20;
  const maxLinkDistance = 50; // Maximum distance for links to be displayed

  const svg = d3
    .select(containerEl)
    .append('svg')
    .attr('width', width)
    .attr('height', height);

  const numNodes = 15;
  const nodes = Array.from({ length: numNodes }, (_, i) => ({
    id: `node-${i}`,
    x: Math.random() * (width - 2 * padding) + padding,
    y: Math.random() * (height - 2 * padding) + padding,
    vx: Math.random() * 2 - 1,
    vy: Math.random() * 2 - 1,
    radius: Math.random() * 5 + 2,
    pulseDelay: Math.random() * 1000,
    pulseRadius: Math.random() * 3 + 2,
  }));

  // Define a blue color scale
  const blueColorScale = d3
    .scaleLinear<string>()
    .domain([0, numNodes / 2, numNodes])
    .range(['#e6f7ff', '#91d5ff', '#1890ff', '#096dd9', '#0050b3', '#003a8c']); // Light blue to darker blue

  let quadtree = d3
    .quadtree()
    .x(d => d.x)
    .y(d => d.y)
    .addAll(nodes);
  const links = [];

  const node = svg
    .selectAll('.node')
    .data(nodes)
    .enter()
    .append('circle')
    .attr('class', 'node')
    .attr('fill', (_, i) => blueColorScale(i));

  function updateLinks() {
    links.length = 0; // Clear the links array

    nodes.forEach(source => {
      quadtree.visit((quad, x1, y1, x2, y2) => {
        if (!quad.length) {
          do {
            const target = quad.data;
            if (target && target !== source) {
              const distance = Math.sqrt(
                (source.x - target.x) ** 2 + (source.y - target.y) ** 2
              );
              if (distance < maxLinkDistance) {
                const opacity = 1 - distance / maxLinkDistance;
                links.push({ source, target, opacity });
              }
            }
          } while ((quad = quad.next));
        }
        return (
          x1 > source.x + maxLinkDistance ||
          x2 < source.x - maxLinkDistance ||
          y1 > source.y + maxLinkDistance ||
          y2 < source.y - maxLinkDistance
        );
      });
    });
  }

  function tick() {
    nodes.forEach(node => {
      node.x += node.vx;
      node.y += node.vy;

      if (node.x < padding || node.x > width - padding) {
        node.vx *= -1;
      }

      if (node.y < padding || node.y > height - padding) {
        node.vy *= -1;
      }
    });

    // Rebuild the quadtree with the updated nodes positions
    quadtree = d3
      .quadtree()
      .x(d => d.x)
      .y(d => d.y)
      .addAll(nodes);

    updateLinks();

    // Update the link selection here, after links have been updated
    const link = svg
      .selectAll('.link')
      .data(links, d => `${d.source.id}-${d.target.id}`);

    link
      .enter()
      .append('line')
      .attr('class', 'link')
      .merge(link)
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y)
      .attr('stroke', '#999')
      .attr('stroke-width', 1)
      .attr('opacity', d => d.opacity);

    link.exit().remove();

    node.attr('cx', d => d.x).attr('cy', d => d.y);
  }

  function pulse(node) {
    node
      .transition()
      .duration(1000)
      .delay(d => d.pulseDelay)
      .attr('r', d => d.radius + d.pulseRadius)
      .transition()
      .duration(1000)
      .attr('r', d => d.radius)
      .on('end', () => pulse(node));
  }

  node.attr('r', d => d.radius);
  pulse(node);
  d3.timer(tick);
}
